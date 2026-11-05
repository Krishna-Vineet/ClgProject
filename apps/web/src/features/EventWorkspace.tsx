import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  ADMISSION_MODES,
  ADMISSION_MODE_LABELS,
  type AccountType,
  type AdmissionMode,
  EVENT_AUDIENCES,
  EVENT_AUDIENCE_LABELS,
  EVENT_TEMPLATES,
  EVENT_TEMPLATE_LABELS,
  type EventAudience,
  type EventTemplate,
  canEditEvent,
  canTransition,
  defaultEligibilityPolicy,
} from "@campusops/shared/ui";
import { type ReactNode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { ConfirmDialog, Loading, Pager, useAction, useToast } from "../components/feedback";
import {
  Card,
  Empty,
  ErrorNote,
  Field,
  formatWhen,
  fromLocalInput,
  toLocalInput,
} from "../components/ui";
import { type Page, api, errorMessage, query } from "../lib/api";
import { PAGE_SIZE } from "../lib/constants";
import type { EventRow } from "../lib/types";
import { type Audience, EligibilityBuilder, parseYears } from "./EligibilityBuilder";

type Policy = {
  version: 1;
  accountTypes: AccountType[];
  departmentIds: string[];
  graduationYears: number[];
  requireInvitation: boolean;
};

type Detail = EventRow & {
  eligibilityPolicy?: Policy;
  jobDescription?: string | null;
  onlineMeetingUrl?: string | null;
};

type EditForm = {
  title: string;
  description: string;
  template: EventTemplate;
  audience: EventAudience;
  admissionMode: AdmissionMode;
  capacity: number;
  startsAt: string;
  endsAt: string;
  registrationOpensAt: string;
  registrationClosesAt: string;
  venueSummary: string;
  onlineMeetingUrl: string;
  jobDescription: string;
  policy: Policy;
};

type Invitation = {
  id: string;
  email: string;
  userId: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

type Revision = {
  revision: { id: string; revision: number; note: string | null; createdAt: string };
  createdBy: { id: string; fullName: string } | null;
};

type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; fullName: string } | null;
  createdAt: string;
};

type Department = { id: string; code: string; name: string };

// Loaded on demand: an organiser who never opens these tabs should not download
// their code.
const AccessQrPanel = lazy(() =>
  import("./AccessQrPanel").then((m) => ({ default: m.AccessQrPanel })),
);
const ComplaintsPanel = lazy(() =>
  import("./ComplaintsPanel").then((m) => ({ default: m.ComplaintsPanel })),
);
const QuizPanel = lazy(() => import("./QuizPanel").then((m) => ({ default: m.QuizPanel })));
const RosterPanel = lazy(() => import("./RosterPanel").then((m) => ({ default: m.RosterPanel })));
const AnnouncementsPanel = lazy(() =>
  import("./AnnouncementsPanel").then((m) => ({ default: m.AnnouncementsPanel })),
);

export type EventWorkspaceTab =
  | "overview"
  | "approvals"
  | "run"
  | "roster"
  | "quiz"
  | "access"
  | "announcements"
  | "complaints"
  | "edit"
  | "invitations"
  | "history";

const TAB_GROUPS: Array<{ label: string; tabs: Array<[EventWorkspaceTab, string]> }> = [
  {
    label: "Plan",
    tabs: [
      ["overview", "Overview"],
      ["approvals", "Approvals"],
      ["edit", "Edit details"],
    ],
  },
  {
    label: "People",
    tabs: [
      ["roster", "Participants"],
      ["invitations", "Invitations"],
    ],
  },
  {
    label: "Run",
    tabs: [
      ["run", "Day of event"],
      ["access", "Access QRs"],
    ],
  },
  {
    label: "Engage",
    tabs: [
      ["announcements", "Announcements"],
      ["quiz", "Quiz"],
      ["complaints", "Complaints"],
    ],
  },
  { label: "Record", tabs: [["history", "History & audit"]] },
];

function toForm(e: Detail): EditForm {
  return {
    title: e.title,
    description: e.description ?? "",
    template: e.template,
    audience: e.audience,
    admissionMode: e.admissionMode,
    capacity: e.capacity,
    startsAt: toLocalInput(new Date(e.startsAt)),
    endsAt: toLocalInput(new Date(e.endsAt)),
    registrationOpensAt: toLocalInput(new Date(e.registrationOpensAt)),
    registrationClosesAt: toLocalInput(new Date(e.registrationClosesAt)),
    venueSummary: e.venueSummary ?? "",
    onlineMeetingUrl: e.onlineMeetingUrl ?? "",
    jobDescription: e.jobDescription ?? "",
    policy: {
      ...defaultEligibilityPolicy,
      ...(e.eligibilityPolicy ?? {}),
      version: 1,
    } as Policy,
  };
}

/**
 * Event operations that go beyond submitting for approval: day-of lifecycle,
 * editing a draft, invitations, and the recorded history of an event.
 * Read-only sections stay visible when the API forbids a write, so a viewer
 * still sees the truth instead of an empty screen.
 */

export function EventWorkspace({
  event,
  onChanged,
  approvals,
  overview,
  initialTab,
  canManage,
}: {
  event: EventRow;
  onChanged: () => Promise<void>;
  approvals?: ((go: (tab: EventWorkspaceTab) => void) => ReactNode) | undefined;
  overview?: ((go: (tab: EventWorkspaceTab) => void) => ReactNode) | undefined;
  initialTab?: EventWorkspaceTab | undefined;
  /** Coordinators (and club leads) of this event's club. Oversight is read-only. */
  canManage: boolean;
}) {
  const toast = useToast();
  const action = useAction();
  const [tab, setTab] = useState<EventWorkspaceTab>(initialTab ?? "overview");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [yearsText, setYearsText] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [invites, setInvites] = useState<Invitation[]>([]);
  const [inviteText, setInviteText] = useState("");
  const [inviteExpiry, setInviteExpiry] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Invitation | null>(null);

  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditMore, setAuditMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [confirm, setConfirm] = useState<null | "start" | "complete" | "delete">(null);

  const id = event.id;

  const loadDetail = useCallback(async () => {
    try {
      const d = await api<Detail>(`/events/${id}`);
      setDetail(d);
      setForm(toForm(d));
      setYearsText((d.eligibilityPolicy?.graduationYears ?? []).join(", "));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    setTab(initialTab ?? "overview");
    setInvites([]);
    setRevisions([]);
    setAudit([]);
    setAuditOffset(0);
    void loadDetail();
    api<{ items: Department[] }>("/departments")
      .then((r) => setDepartments(r.items))
      .catch(() => setDepartments([]));
  }, [loadDetail, initialTab]);

  const loadInvites = useCallback(async () => {
    try {
      const r = await api<{ items: Invitation[] }>(`/events/${id}/invitations`);
      setInvites(r.items);
      setInviteError(null);
    } catch (err) {
      setInviteError(errorMessage(err));
    }
  }, [id]);

  const loadHistory = useCallback(
    async (offset: number) => {
      try {
        const [revs, logs] = await Promise.all([
          api<{ items: Revision[] }>(`/events/${id}/revisions`),
          api<Page<AuditEntry>>(`/events/${id}/audit${query({ limit: PAGE_SIZE, offset })}`),
        ]);
        setRevisions(revs.items);
        setAudit(logs.items);
        setAuditMore(logs.hasMore ?? false);
        setAuditOffset(offset);
        setHistoryError(null);
      } catch (err) {
        setHistoryError(errorMessage(err));
      }
    },
    [id],
  );

  function selectTab(next: EventWorkspaceTab) {
    setTab(next);
    if (next === "invitations") void loadInvites();
    if (next === "history") void loadHistory(0);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !detail) return;
    const startsAt = new Date(fromLocalInput(form.startsAt));
    const endsAt = new Date(fromLocalInput(form.endsAt));
    const closesAt = new Date(fromLocalInput(form.registrationClosesAt));
    const opensAt = new Date(fromLocalInput(form.registrationOpensAt));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      toast.err("Set both the start and end of the event.");
      return;
    }
    if (endsAt <= startsAt) {
      toast.err("The event must end after it starts.");
      return;
    }
    if (closesAt > startsAt) {
      toast.err("Registration must close at or before the event starts.");
      return;
    }
    if (opensAt > closesAt) {
      toast.err("Registration must open before it closes.");
      return;
    }
    const graduationYears = parseYears(yearsText);
    const scheduleChanged =
      fromLocalInput(form.startsAt) !== fromLocalInput(toLocalInput(new Date(detail.startsAt))) ||
      fromLocalInput(form.endsAt) !== fromLocalInput(toLocalInput(new Date(detail.endsAt))) ||
      fromLocalInput(form.registrationOpensAt) !==
        fromLocalInput(toLocalInput(new Date(detail.registrationOpensAt))) ||
      fromLocalInput(form.registrationClosesAt) !==
        fromLocalInput(toLocalInput(new Date(detail.registrationClosesAt))) ||
      (form.venueSummary || null) !== (detail.venueSummary ?? null) ||
      (form.onlineMeetingUrl || null) !== (detail.onlineMeetingUrl ?? null);
    await action.run(async () => {
      await api(
        `/events/${id}`,
        {
          title: form.title,
          description: form.description,
          template: form.template,
          audience: form.audience,
          admissionMode: form.admissionMode,
          capacity: Number(form.capacity),
          jobDescription: form.jobDescription || null,
          eligibilityPolicy: { ...form.policy, graduationYears },
          // The schedule and venue are what an approval covered. A live event
          // still accepts them, but the server turns that save into a new draft
          // revision — so only send them when they actually changed, otherwise
          // every typo fix would start an approval round.
          ...(scheduleChanged
            ? {
                startsAt: fromLocalInput(form.startsAt),
                endsAt: fromLocalInput(form.endsAt),
                registrationOpensAt: fromLocalInput(form.registrationOpensAt),
                registrationClosesAt: fromLocalInput(form.registrationClosesAt),
                venueSummary: form.venueSummary || null,
                onlineMeetingUrl: form.onlineMeetingUrl || null,
              }
            : event.status === "DRAFT"
              ? {
                  startsAt: fromLocalInput(form.startsAt),
                  endsAt: fromLocalInput(form.endsAt),
                  registrationOpensAt: fromLocalInput(form.registrationOpensAt),
                  registrationClosesAt: fromLocalInput(form.registrationClosesAt),
                  venueSummary: form.venueSummary || null,
                  onlineMeetingUrl: form.onlineMeetingUrl || null,
                }
              : {}),
          expectedRevision: detail.currentRevision,
        },
        { method: "PATCH" },
      );
      // Say what actually happened: a schedule change on a live event is not a
      // quiet edit, it reopens approvals, and the coordinator must know that.
      toast.ok(
        event.status === "DRAFT"
          ? "Draft updated."
          : scheduleChanged
            ? "Saved as a new draft revision. Time and venue changes need fresh approval before this event can be published again."
            : "Event updated. Students see the change immediately.",
      );
      await loadDetail();
      await onChanged();
    });
  }

  async function transition(kind: "start" | "complete") {
    setConfirm(null);
    await action.run(async () => {
      await api(`/events/${id}/${kind}`, {});
      toast.ok(kind === "start" ? "Event is live." : "Event completed. Resources released.");
      await loadDetail();
      await onChanged();
    });
  }

  /**
   * Delete a draft. Delegates the decision to the API rather than guessing: only
   * a DRAFT with no registrations and no scans may be erased, and the server is
   * the only place that can check all three at once.
   */
  async function removeDraft() {
    setConfirm(null);
    await action.run(async () => {
      await api(`/events/${id}`, undefined, { method: "DELETE" });
      toast.ok("Draft deleted.");
      // The list no longer contains it, so there is nothing to reload here.
      await onChanged();
    });
  }

  async function sendInvites(e: React.FormEvent) {
    e.preventDefault();
    const emails = inviteText
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (emails.length === 0) {
      setInviteError("Enter at least one email address.");
      return;
    }
    await action.run(async () => {
      try {
        const r = await api<{ created?: number; invited?: number; items?: unknown[] }>(
          `/events/${id}/invitations`,
          {
            emails,
            expiresAt: inviteExpiry ? fromLocalInput(inviteExpiry) : null,
          },
        );
        const n = r.created ?? r.invited ?? r.items?.length ?? emails.length;
        toast.ok(`${n} invitation${n === 1 ? "" : "s"} recorded.`);
        setInviteText("");
        setInviteExpiry("");
        setInviteError(null);
        await loadInvites();
      } catch (err) {
        setInviteError(errorMessage(err));
      }
    });
  }

  async function doRevoke() {
    if (!revoke) return;
    const target = revoke;
    setRevoke(null);
    await action.run(async () => {
      await api(`/events/${id}/invitations/${target.id}`, undefined, { method: "DELETE" });
      toast.ok("Invitation revoked.");
      await loadInvites();
    });
  }

  const editable = canManage && canEditEvent(event.status);
  const canStart = canTransition(event.status, "LIVE");
  const canComplete = event.status === "LIVE" || event.status === "PUBLISHED";
  const live = detail ?? event;

  return (
    <Card
      title="Event workspace"
      subtitle={
        canManage
          ? "Everything for this event, grouped by what you are doing."
          : "Read-only view. Decisions on approvals are yours; changing the event belongs to its coordinators."
      }
    >
      <div className="event-workspace">
        <nav className="event-nav" aria-label="Event sections">
          {TAB_GROUPS.map((group) => (
            <div className="event-nav-group" key={group.label}>
              <span>{group.label}</span>
              {group.tabs
                .filter(([key]) => canManage || key !== "edit")
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={tab === key ? "active" : "ghost"}
                    aria-current={tab === key ? "page" : undefined}
                    onClick={() => selectTab(key)}
                  >
                    {label}
                  </button>
                ))}
            </div>
          ))}
        </nav>

        <div className="event-content">
          <ErrorNote message={error} />

          {tab === "overview" &&
            (overview ? (
              overview(selectTab)
            ) : (
              <p className="meta">
                {event.status.replace(/_/g, " ")} · revision {event.currentRevision}
              </p>
            ))}

          {tab === "approvals" &&
            (approvals ? (
              approvals(selectTab)
            ) : (
              <Empty>Approval details are not available for this event.</Empty>
            ))}

          {tab === "run" && (
            <>
              <p className="meta">
                Current status: <strong>{event.status.replace(/_/g, " ")}</strong> · revision{" "}
                {event.currentRevision}
              </p>
              <div className="row">
                <button
                  type="button"
                  disabled={!canManage || !canStart || action.busy}
                  onClick={() => setConfirm("start")}
                >
                  Start event
                </button>
                <button
                  type="button"
                  disabled={!canManage || !canComplete || action.busy}
                  onClick={() => setConfirm("complete")}
                >
                  Mark completed
                </button>
              </div>
              <ul className="plain hint">
                <li>
                  <strong>Start</strong> moves a published event to LIVE so check-in scanning can
                  run.
                </li>
                <li>
                  <strong>Complete</strong> closes the event and releases its resource holds.
                  Reports can be filed once the event has ended.
                </li>
                {!canManage && (
                  <li>
                    Starting and completing the event belongs to its club coordinators. You can
                    follow the status here and in the scan log.
                  </li>
                )}
                {canManage && !canStart && !canComplete && (
                  <li>
                    No day-of action is available from {event.status.replace(/_/g, " ")}. Publish
                    the event first, or check that it is not already closed.
                  </li>
                )}
              </ul>
              {live.cancellationReason && (
                <p className="warn-note">Cancellation reason: {live.cancellationReason}</p>
              )}
            </>
          )}

          {tab === "roster" && (
            <Suspense fallback={<Loading label="Loading participants…" />}>
              <RosterPanel event={live} canManage={canManage} />
            </Suspense>
          )}

          {tab === "quiz" && (
            <Suspense fallback={<Loading label="Loading quiz…" />}>
              <QuizPanel event={live} canManage={canManage} />
            </Suspense>
          )}

          {tab === "announcements" && (
            <Suspense fallback={<Loading label="Loading announcements…" />}>
              <AnnouncementsPanel event={live} canManage={canManage} />
            </Suspense>
          )}

          {tab === "access" && (
            <Suspense fallback={<Loading label="Loading access QRs…" />}>
              <AccessQrPanel event={live} canManage={canManage} />
            </Suspense>
          )}

          {tab === "complaints" && (
            <Suspense fallback={<Loading label="Loading complaints…" />}>
              <ComplaintsPanel event={live} canManage={canManage} />
            </Suspense>
          )}

          {tab === "edit" && !canManage && (
            <Empty>Only this event&apos;s club coordinators can edit its details.</Empty>
          )}

          {tab === "edit" && canManage && !editable && (
            <Empty title="This event is finished">
              A completed or cancelled event is kept as history. Create a new event if you are
              running it again.
            </Empty>
          )}

          {tab === "edit" && editable && !form && <Loading label="Loading draft…" />}

          {tab === "edit" && editable && form && (
            <form className="form wide" onSubmit={saveEdit}>
              {event.status === "DRAFT" && (
                <div className="danger-zone span-2">
                  <div>
                    <strong>Delete this draft</strong>
                    <p className="meta">
                      Nothing has been published, nobody has registered, and no reviewer has been
                      asked. Deleting removes it outright. Once an event has been seen by anyone, it
                      is cancelled instead so the record survives.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="danger"
                    disabled={action.busy}
                    onClick={() => setConfirm("delete")}
                  >
                    Delete draft
                  </button>
                </div>
              )}
              {event.status !== "DRAFT" && (
                // The old copy was one dense sentence that named two rules, a
                // status and an approval consequence at once, and it did not say
                // which fields were which. Splitting it into "applies now" vs
                // "needs approval", each labelled on the field itself, is the
                // same information where it is actually needed.
                <section className="edit-rules span-2">
                  <h4>
                    This event is {event.status.replace(/_/g, " ").toLowerCase()}. Editing still
                    works — in two ways.
                  </h4>
                  <ul className="plain">
                    <li>
                      <span className="rule-tag now">Applies now</span>
                      Title, description, banner, template, job description, capacity, eligibility.
                      Participants see the change immediately; no new approval is needed.
                    </li>
                    <li>
                      <span className="rule-tag later">New approval</span>
                      Time, venue, and the registration window. These are what was approved, so
                      saving them creates a new draft revision of this event and it must pass
                      approval again before it goes back out. People already registered keep their
                      places.
                    </li>
                  </ul>
                </section>
              )}
              <h3 className="span-2">Event basics</h3>
              <p className="form-group-note span-2">
                <span className="rule-tag now">Applies now</span>
              </p>
              <Field label="Title">
                <input
                  required
                  minLength={3}
                  maxLength={180}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </Field>
              <Field label="Template">
                <select
                  value={form.template}
                  onChange={(e) => setForm({ ...form, template: e.target.value as EventTemplate })}
                >
                  {EVENT_TEMPLATES.map((t) => (
                    <option key={t} value={t}>
                      {EVENT_TEMPLATE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Audience">
                <select
                  value={form.audience}
                  onChange={(e) => setForm({ ...form, audience: e.target.value as EventAudience })}
                >
                  {EVENT_AUDIENCES.map((a) => (
                    <option key={a} value={a}>
                      {EVENT_AUDIENCE_LABELS[a]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Admission" hint="Quiz modes need a quiz attached to the event.">
                <select
                  value={form.admissionMode}
                  onChange={(e) =>
                    setForm({ ...form, admissionMode: e.target.value as AdmissionMode })
                  }
                >
                  {ADMISSION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {ADMISSION_MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Capacity">
                <input
                  type="number"
                  min={1}
                  max={100000}
                  required
                  value={form.capacity}
                  onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })}
                />
              </Field>
              <h3 className="span-2">Schedule and registration</h3>
              {/* Same tag vocabulary as the panel above, so the rule is attached to
                  the fields it applies to instead of only being described once at
                  the top of the form. */}
              {event.status !== "DRAFT" && (
                <p className="form-group-note span-2">
                  <span className="rule-tag later">New approval</span>
                  Changing anything in this section creates a new draft revision.
                </p>
              )}
              <Field label="Starts">
                <input
                  type="datetime-local"
                  required
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              </Field>
              <Field label="Ends">
                <input
                  type="datetime-local"
                  required
                  value={form.endsAt}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                />
              </Field>
              <Field label="Registration opens">
                <input
                  type="datetime-local"
                  required
                  value={form.registrationOpensAt}
                  onChange={(e) => setForm({ ...form, registrationOpensAt: e.target.value })}
                />
              </Field>
              <Field label="Registration closes" hint="At or before the event starts.">
                <input
                  type="datetime-local"
                  required
                  value={form.registrationClosesAt}
                  onChange={(e) => setForm({ ...form, registrationClosesAt: e.target.value })}
                />
              </Field>
              <Field label="Venue summary">
                <input
                  maxLength={300}
                  value={form.venueSummary}
                  onChange={(e) => setForm({ ...form, venueSummary: e.target.value })}
                />
              </Field>
              <Field label="Online meeting URL">
                <input
                  type="url"
                  value={form.onlineMeetingUrl}
                  placeholder="https://…"
                  onChange={(e) => setForm({ ...form, onlineMeetingUrl: e.target.value })}
                />
              </Field>
              <h3 className="span-2">Description and placement details</h3>
              <Field label="Description">
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </Field>
              <Field
                label="Job description"
                hint="For placement drives: role, requirements and package details."
              >
                <textarea
                  rows={4}
                  maxLength={20000}
                  value={form.jobDescription}
                  onChange={(e) => setForm({ ...form, jobDescription: e.target.value })}
                />
              </Field>

              <EligibilityBuilder
                audience={form.audience as Audience}
                policy={form.policy}
                departments={departments}
                yearsText={yearsText}
                onChange={(next) =>
                  setForm({
                    ...form,
                    ...(next.audience ? { audience: next.audience as EventAudience } : {}),
                    ...(next.policy ? { policy: next.policy } : {}),
                  })
                }
              />

              <div className="row">
                <button type="submit" disabled={action.busy}>
                  {action.busy ? "Saving…" : "Save draft"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    if (!detail) return;
                    setForm(toForm(detail));
                    setYearsText((detail.eligibilityPolicy?.graduationYears ?? []).join(", "));
                  }}
                >
                  Reset
                </button>
              </div>
            </form>
          )}

          {tab === "invitations" && (
            <>
              {!canManage && (
                <p className="meta">
                  Invitations are read-only here. Only this event&apos;s club coordinators can add
                  or revoke them.
                </p>
              )}
              {event.status !== "PUBLISHED" && event.status !== "LIVE" && canManage && (
                <p className="warn-note">
                  This event is {event.status.replace(/_/g, " ").toLowerCase()} and not open for
                  registration yet. You can prepare invitations now; they start admitting people
                  once the event is published.
                </p>
              )}
              {event.audience === "COLLEGE_ONLY" && (
                <p className="warn-note">
                  This event is college-only. Invitations matter for events open to outsiders or
                  marked invited-only.
                </p>
              )}
              {detail &&
                !detail.eligibilityPolicy?.requireInvitation &&
                event.audience !== "COLLEGE_ONLY" && (
                  <p className="meta">
                    This event does not require an invitation. Eligible students can register
                    without one; these addresses are recorded for follow-up. Turn on{" "}
                    <strong>Require an invitation</strong> in Edit details to gate registration.
                  </p>
                )}
              {canManage && (
                <form className="form" onSubmit={sendInvites}>
                  <Field label="Email addresses" hint="Separate with commas, spaces or new lines.">
                    <textarea
                      rows={3}
                      value={inviteText}
                      placeholder="student@othercollege.edu"
                      onChange={(e) => setInviteText(e.target.value)}
                    />
                  </Field>
                  <Field label="Expires (optional)">
                    <input
                      type="datetime-local"
                      value={inviteExpiry}
                      onChange={(e) => setInviteExpiry(e.target.value)}
                    />
                  </Field>
                  {inviteError && <ErrorNote message={inviteError} />}
                  <button type="submit" disabled={action.busy}>
                    Invite
                  </button>
                </form>
              )}

              {invites.length === 0 ? (
                <Empty>No invitations recorded for this event.</Empty>
              ) : (
                <div className="scroll-x">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Linked account</th>
                        <th>Accepted</th>
                        <th>Expires</th>
                        <th>State</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {invites.map((inv) => (
                        <tr key={inv.id}>
                          <td>{inv.email}</td>
                          <td>{inv.userId ? "Yes" : "Not registered yet"}</td>
                          <td>{inv.acceptedAt ? formatWhen(inv.acceptedAt) : "—"}</td>
                          <td>{inv.expiresAt ? formatWhen(inv.expiresAt) : "No expiry"}</td>
                          <td>{inv.revokedAt ? "Revoked" : "Active"}</td>
                          <td>
                            {!inv.revokedAt && (
                              <button
                                type="button"
                                className="danger tiny"
                                disabled={action.busy}
                                onClick={() => setRevoke(inv)}
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === "history" && (
            <>
              {historyError && <ErrorNote message={historyError} />}
              <h3>Revisions</h3>
              {revisions.length === 0 ? (
                <Empty>No revisions recorded.</Empty>
              ) : (
                <div className="scroll-x">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>Revision</th>
                        <th>Note</th>
                        <th>By</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revisions.map((r) => (
                        <tr key={r.revision.id}>
                          <td>{r.revision.revision}</td>
                          <td>{r.revision.note ?? "—"}</td>
                          <td>{r.createdBy?.fullName ?? "System"}</td>
                          <td>{formatWhen(r.revision.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3>Audit trail</h3>
              {audit.length === 0 ? (
                <Empty>No audit entries visible to you for this event.</Empty>
              ) : (
                <>
                  <div className="scroll-x">
                    <table className="grid">
                      <thead>
                        <tr>
                          <th>Action</th>
                          <th>Entity</th>
                          <th>Actor</th>
                          <th>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.map((a) => (
                          <tr key={a.id}>
                            <td>{a.action.replace(/_/g, " ").toLowerCase()}</td>
                            <td>{a.entityType.replace(/_/g, " ")}</td>
                            <td>{a.actor?.fullName ?? "System"}</td>
                            <td>{formatWhen(a.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager
                    offset={auditOffset}
                    limit={PAGE_SIZE}
                    hasMore={auditMore}
                    count={audit.length}
                    onChange={(o) => void loadHistory(o)}
                  />
                </>
              )}
            </>
          )}

          <ConfirmDialog
            open={revoke !== null}
            title={`Revoke the invitation for ${revoke?.email ?? ""}?`}
            description="They will no longer be able to register for this event through the invitation. You can invite the address again later."
            confirmLabel="Revoke"
            busy={action.busy}
            onCancel={() => setRevoke(null)}
            onConfirm={() => void doRevoke()}
          />

          <ConfirmDialog
            open={confirm !== null}
            title={
              confirm === "start"
                ? "Start this event?"
                : confirm === "delete"
                  ? `Delete “${event.title}”?`
                  : "Mark this event completed?"
            }
            description={
              confirm === "start"
                ? "The event becomes LIVE and participants can check in."
                : confirm === "delete"
                  ? "A draft has not been seen by anyone: no registrations, no scans, no reviewer has been asked. It is removed outright and cannot be recovered. Events that people have already seen are cancelled instead, so their history survives."
                  : "The event is closed and its resource holds are released. This cannot be undone."
            }
            confirmLabel={
              confirm === "start"
                ? "Start event"
                : confirm === "delete"
                  ? "Delete draft"
                  : "Mark completed"
            }
            danger={confirm === "complete" || confirm === "delete"}
            busy={action.busy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              if (confirm === "delete") void removeDraft();
              else if (confirm) void transition(confirm);
            }}
          />
        </div>
      </div>
    </Card>
  );
}
