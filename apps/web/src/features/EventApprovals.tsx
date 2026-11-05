import { APPROVAL_TIER_LABELS, APPROVAL_TYPE_LABELS } from "@campusops/shared/ui";
import { useState } from "react";
import { FormDialog } from "../components/feedback";
import { Icon } from "../components/icons";
import {
  ApprovalBadge,
  Empty,
  ErrorNote,
  Field,
  SuccessNote,
  formatWhen,
  fromLocalInput,
  toLocalInput,
} from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import type { ApprovalRequestRow, Approver, AvailabilityItem, EventBundle } from "../lib/types";

type RequestDraft = {
  key: string;
  type: "ORGANIZE" | "INVITE_OUTSIDERS" | "RESOURCE_USE" | "CUSTOM";
  title: string;
  isRequired: boolean;
  assignedApproverId: string;
  resourceUnitId: string;
};

type ResourceEdit = { unitId: string; startsAt: string; endsAt: string };

const PRESETS: Array<{
  type: RequestDraft["type"];
  label: string;
}> = [
  { type: "ORGANIZE", label: "Organize event", },
  {
    type: "INVITE_OUTSIDERS",
    label: "Invite outsiders",
  },
  {
    type: "RESOURCE_USE",
    label: "Book a resource",
  },
  {
    type: "CUSTOM",
    label: "Custom permission",
  },
];

function defaultTitle(type: RequestDraft["type"]) {
  return type === "ORGANIZE"
    ? "Permission to organize"
    : type === "INVITE_OUTSIDERS"
      ? "Permission to invite outsiders"
      : type === "RESOURCE_USE"
        ? "Resource use"
        : "Additional permission";
}

/**
 * Everything that decides whether an event may run: build the permission
 * bundle, track each decision, repair a request when changes are asked for, and
 * publish when the last required approval lands.
 */
export function EventApprovals({
  bundle,
  approvers,
  units,
  canManage,
  onRefresh,
}: {
  bundle: EventBundle;
  approvers: Approver[];
  units: AvailabilityItem[];
  canManage: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { me, isAdmin } = useSession();
  const [drafts, setDrafts] = useState<RequestDraft[]>([]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [resourceEdits, setResourceEdits] = useState<Record<string, ResourceEdit>>({});
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseNote, setReviseNote] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const event = bundle.event;
  const summary = bundle.summary;
  const open = bundle.requests.filter((r) =>
    ["PENDING", "CHANGES_REQUESTED"].includes(r.request.status),
  );
  const changes = bundle.requests.filter((r) => r.request.status === "CHANGES_REQUESTED");
  const requiredChange = changes.some((r) => r.request.isRequired);

  function canDecide(request: ApprovalRequestRow) {
    if (request.status !== "PENDING") return false;
    // Faculty-tier requests are always personally assigned.
    if (request.assignedApproverId) return request.assignedApproverId === me?.user.id;
    if (request.currentTier === "ADMIN") return isAdmin;
    if (request.currentTier === "SENIOR") {
      const departmentId = bundle.club.departmentId ?? null;
      return (me?.globalRoles ?? []).some(
        (role) =>
          role.role === "HOD_DEAN" &&
          (role.scopeType === "GLOBAL" ||
            (departmentId !== null && role.departmentId === departmentId)),
      );
    }
    // An unassigned faculty request belongs in a queue an Admin must reassign.
    return false;
  }

  function resourceApprovalBlocked(request: ApprovalRequestRow) {
    if (!canDecide(request) || request.type !== "RESOURCE_USE") return null;
    if (event.status === "DRAFT")
      return "The event is back in draft. Fix the event with the coordinator before approving its resource.";
    if (requiredChange)
      return "Another required permission is waiting on changes. The coordinator must fix and resubmit the event before its resources can be approved.";
    return null;
  }

  function decide(request: ApprovalRequestRow, action: "APPROVE" | "REJECT" | "REQUEST_CHANGES") {
    const comment = (comments[request.id] ?? "").trim();
    if (action !== "APPROVE" && comment.length < 3) {
      setError("Add a short note so the coordinator knows what to change or why it was rejected.");
      return;
    }
    void run(
      async () => {
        await api(`/approval-requests/${request.id}/decision`, {
          action,
          ...(comment ? { comment } : {}),
          expectedVersion: request.version,
        });
        setComments((prev) => {
          const next = { ...prev };
          delete next[request.id];
          return next;
        });
      },
      action === "APPROVE"
        ? "Approved. The coordinator can see the decision."
        : action === "REJECT"
          ? "Rejected. The coordinator is notified."
          : "Changes requested. The coordinator can repair this request.",
    );
  }

  async function run(task: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
      setNotice(message);
      await onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function addDraft(type: RequestDraft["type"]) {
    setDrafts((prev) => [
      ...prev,
      {
        key: `${type}-${Date.now()}-${prev.length}`,
        type,
        title: defaultTitle(type),
        isRequired: type !== "CUSTOM",
        assignedApproverId: approvers[0]?.id ?? "",
        resourceUnitId: "",
      },
    ]);
  }

  function submit() {
    if (drafts.length === 0) {
      setError("Add at least one permission before submitting.");
      return;
    }
    if (drafts.some((d) => !d.assignedApproverId)) {
      setError("Choose who reviews each permission. Every request needs a named reviewer.");
      return;
    }
    void run(async () => {
      await api(`/events/${event.id}/submit`, {
        expectedRevision: event.currentRevision,
        requests: drafts.map((draft) => ({
          type: draft.type,
          title: draft.title.trim(),
          isRequired: draft.isRequired,
          assignedApproverId: draft.assignedApproverId,
          resources:
            draft.type === "RESOURCE_USE" && draft.resourceUnitId
              ? [
                  {
                    resourceUnitId: draft.resourceUnitId,
                    startsAt: event.startsAt,
                    endsAt: event.endsAt,
                  },
                ]
              : [],
        })),
      });
      setDrafts([]);
    }, "Submitted. Each permission is now decided separately and you can follow it here.");
  }

  function startResourceEdit(request: ApprovalRequestRow) {
    const existing = bundle.requests.find((r) => r.request.id === request.id)?.resources[0];
    setResourceEdits((prev) => ({
      ...prev,
      [request.id]: {
        unitId: existing?.unit.id ?? "",
        startsAt: toLocalInput(new Date(existing?.link.startsAt ?? event.startsAt)),
        endsAt: toLocalInput(new Date(existing?.link.endsAt ?? event.endsAt)),
      },
    }));
  }

  function resubmitResources(request: ApprovalRequestRow) {
    const edit = resourceEdits[request.id];
    if (!edit?.unitId) {
      setError("Choose a resource unit before resubmitting.");
      return;
    }
    void run(async () => {
      await api(`/approval-requests/${request.id}/resources`, {
        expectedVersion: request.version,
        resources: [
          {
            resourceUnitId: edit.unitId,
            startsAt: fromLocalInput(edit.startsAt),
            endsAt: fromLocalInput(edit.endsAt),
          },
        ],
      });
      setResourceEdits(({ [request.id]: _removed, ...rest }) => rest);
    }, "Resource request updated and sent back to the reviewer. The event stays in the approval flow.");
  }

  function revise() {
    void run(async () => {
      await api(`/events/${event.id}/revisions`, {
        expectedRevision: event.currentRevision,
        note: reviseNote.trim() || "Coordinator revised the event after reviewer feedback.",
      });
      setReviseOpen(false);
      setReviseNote("");
    }, "A new draft revision is ready. Update the details, then build and submit a fresh approval bundle.");
  }

  function publish() {
    void run(async () => {
      await api(`/events/${event.id}/publish`, { expectedRevision: event.currentRevision });
    }, "Event published.");
  }

  function cancel() {
    if (cancelReason.trim().length < 5) {
      setError("Give a short reason (at least 5 characters).");
      return;
    }
    void run(async () => {
      await api(`/events/${event.id}/cancel`, { reason: cancelReason.trim() });
      setCancelOpen(false);
      setCancelReason("");
    }, "Event cancelled and its resource holds released.");
  }

  return (
    <div className="stack">
      <ErrorNote message={error} />
      <SuccessNote message={notice} />

      {bundle.bundle === null ? (
        canManage ? (
          <section className="approval-block">
            <header className="block-head">
              <div>
                <h3>Build the permission bundle</h3>
                <p className="meta">
                  Add only what this event needs. Each permission is reviewed on its own, so a
                  rejected optional request does not block the event.
                </p>
              </div>
            </header>
            <div className="approval-presets">
              {PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.type}
                  className="preset"
                  onClick={() => addDraft(preset.type)}
                >
                    <strong>{preset.label}</strong>
                </button>
              ))}
            </div>

            {drafts.length === 0 ? (
              <Empty title="No permissions added" icon="check">
                Start with Organize, then add outsiders or a resource only if this event needs them.
              </Empty>
            ) : (
              <div className="approval-drafts">
                {drafts.map((draft, index) => (
                  <article className="approval-draft" key={draft.key}>
                    <div className="draft-head">
                      <span className="badge muted">{APPROVAL_TYPE_LABELS[draft.type]}</span>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    </div>
                    <div className="grid-3">
                      <Field label="What is being asked">
                        <input
                          required
                          minLength={3}
                          maxLength={180}
                          value={draft.title}
                          onChange={(e) =>
                            setDrafts((prev) =>
                              prev.map((x, i) =>
                                i === index ? { ...x, title: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </Field>
                      {/* A permission is always addressed to a person. An
                          unassigned request is nobody's job, which is why the
                          "role queue" fallback was a trap rather than a shortcut. */}
                      <Field label="Reviewer">
                        <select
                          required
                          value={draft.assignedApproverId}
                          onChange={(e) =>
                            setDrafts((prev) =>
                              prev.map((x, i) =>
                                i === index ? { ...x, assignedApproverId: e.target.value } : x,
                              ),
                            )
                          }
                        >
                          {!draft.assignedApproverId && (
                            <option value="">Choose a reviewer…</option>
                          )}
                          {approvers.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.fullName}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Needed?">
                        <select
                          value={draft.isRequired ? "required" : "optional"}
                          onChange={(e) =>
                            setDrafts((prev) =>
                              prev.map((x, i) =>
                                i === index
                                  ? { ...x, isRequired: e.target.value === "required" }
                                  : x,
                              ),
                            )
                          }
                        >
                          <option value="required">Required to publish</option>
                          <option value="optional">Optional — a rejection is advisory</option>
                        </select>
                      </Field>
                    </div>
                    {draft.type === "RESOURCE_USE" && (
                      <Field
                        label="Resource unit"
                        hint="Only units free for the entire event window appear."
                      >
                        <select
                          value={draft.resourceUnitId}
                          onChange={(e) =>
                            setDrafts((prev) =>
                              prev.map((x, i) =>
                                i === index ? { ...x, resourceUnitId: e.target.value } : x,
                              ),
                            )
                          }
                        >
                          <option value="">Select a unit…</option>
                          {units
                            .filter((u) => u.available)
                            .map((u) => (
                              <option key={u.resourceUnitId} value={u.resourceUnitId}>
                                {u.resourceName} — {u.unitLabel}
                              </option>
                            ))}
                        </select>
                      </Field>
                    )}
                  </article>
                ))}
              </div>
            )}

            <div className="row">
              <button type="button" disabled={busy || drafts.length === 0} onClick={submit}>
                {busy ? "Submitting…" : "Submit for approval"}
              </button>
              <span className="hint">
                The event stays a draft until this bundle is submitted. Approvers see each
                permission in their inbox.
              </span>
            </div>
          </section>
        ) : (
          <Empty>
            No approval bundle has been submitted yet. Only this event&apos;s club coordinators can
            build and submit one.
          </Empty>
        )
      ) : (
        <>
          {changes.length > 0 && (
            <section className="change-banner">
              <div>
                <strong>
                  {changes.length} permission{changes.length === 1 ? "" : "s"} need
                  {changes.length === 1 ? "s" : ""} your attention
                </strong>
                <p>
                  The reviewer asked for a change instead of approving. Read their note, fix it
                  below, and send it back — you do not need to cancel the event.
                </p>
              </div>
            </section>
          )}

          <section className="approval-block">
            <header className="block-head">
              <div>
                <h3>Approval progress</h3>
                <p className="meta">
                  {summary.requiredApproved}/{summary.required} required approved ·{" "}
                  {summary.pending} pending
                  {summary.changesRequested > 0
                    ? ` · ${summary.changesRequested} changes requested`
                    : ""}
                </p>
              </div>
              <div className="progress-track" aria-hidden="true">
                <span
                  style={{
                    width: `${
                      summary.required === 0
                        ? 100
                        : Math.round((summary.requiredApproved / summary.required) * 100)
                    }%`,
                  }}
                />
              </div>
            </header>

            <div className="approval-requests">
              {bundle.requests.map(({ request, assignee, resources, lastAction }) => {
                const edit = resourceEdits[request.id];
                const canEditResources =
                  request.type === "RESOURCE_USE" && request.status === "CHANGES_REQUESTED";
                return (
                  <article
                    className={`approval-request status-${request.status.toLowerCase()}`}
                    key={request.id}
                  >
                    <header>
                      <div>
                        <strong>{request.title}</strong>
                        <p className="meta">
                          {APPROVAL_TYPE_LABELS[request.type]} ·{" "}
                          {request.isRequired ? "required" : "optional"} ·{" "}
                          {APPROVAL_TIER_LABELS[request.currentTier]}
                        </p>
                      </div>
                      <ApprovalBadge status={request.status} />
                    </header>

                    <dl className="approval-facts">
                      <div>
                        <dt>Reviewer</dt>
                        <dd>{assignee?.fullName ?? "Unassigned"}</dd>
                      </div>
                      <div>
                        <dt>Version</dt>
                        <dd>v{request.version}</dd>
                      </div>
                      {resources.length > 0 && (
                        <div>
                          <dt>Resource</dt>
                          <dd>
                            {resources
                              .map(
                                (r) =>
                                  `${r.unit.label} · ${formatWhen(r.link.startsAt)} – ${formatWhen(
                                    r.link.endsAt,
                                  )}`,
                              )
                              .join(", ")}
                          </dd>
                        </div>
                      )}
                    </dl>

                    {lastAction && (
                      <div
                        className={
                          request.status === "CHANGES_REQUESTED"
                            ? "review-note change"
                            : "review-note"
                        }
                      >
                        <strong>
                          {lastAction.action.action === "REQUEST_CHANGES"
                            ? "Changes requested"
                            : lastAction.action.action.replace(/_/g, " ").toLowerCase()}{" "}
                          by {lastAction.actor?.fullName ?? "an approver"}
                        </strong>
                        <p>{lastAction.action.comment || "No comment was left."}</p>
                        <small>{formatWhen(lastAction.action.createdAt)}</small>
                      </div>
                    )}

                    {canDecide(request) && (
                      <div className="review-box">
                        <div className="review-box-head">
                          <strong>Your decision</strong>
                          <span className="meta">
                            {request.currentTier.replace(/_/g, " ").toLowerCase()} · v
                            {request.version}
                          </span>
                        </div>
                        {resourceApprovalBlocked(request) && (
                          <p className="warn-note">{resourceApprovalBlocked(request)}</p>
                        )}
                        <Field label="Note" hint="Required when rejecting or asking for changes.">
                          <textarea
                            rows={2}
                            maxLength={2000}
                            value={comments[request.id] ?? ""}
                            placeholder="What needs to change, or why this cannot be approved."
                            onChange={(e) =>
                              setComments((prev) => ({ ...prev, [request.id]: e.target.value }))
                            }
                          />
                        </Field>
                        <div className="row wrap">
                          <button
                            type="button"
                            disabled={busy || Boolean(resourceApprovalBlocked(request))}
                            onClick={() => decide(request, "APPROVE")}
                          >
                            <Icon name="check" size={14} /> Approve
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy}
                            onClick={() => decide(request, "REQUEST_CHANGES")}
                          >
                            Ask for changes
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={busy}
                            onClick={() => decide(request, "REJECT")}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    )}

                    {canDecide(request) && (
                      <p className="hint">
                        Approving a resource reserves the room or equipment. If the event still has
                        changes to make, that approval stays locked until the coordinator fixes it.
                      </p>
                    )}

                    {canManage && canEditResources && !edit && (
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => startResourceEdit(request)}
                      >
                        Change the resource or time
                      </button>
                    )}

                    {canManage && canEditResources && edit && (
                      <div className="resource-edit">
                        <Field label="Resource unit">
                          <select
                            value={edit.unitId}
                            onChange={(e) =>
                              setResourceEdits((prev) => ({
                                ...prev,
                                [request.id]: { ...edit, unitId: e.target.value },
                              }))
                            }
                          >
                            <option value="">Select a unit…</option>
                            {units
                              .filter((u) => u.available || u.resourceUnitId === edit.unitId)
                              .map((u) => (
                                <option key={u.resourceUnitId} value={u.resourceUnitId}>
                                  {u.resourceName} — {u.unitLabel}
                                </option>
                              ))}
                          </select>
                        </Field>
                        <Field label="From">
                          <input
                            type="datetime-local"
                            value={edit.startsAt}
                            onChange={(e) =>
                              setResourceEdits((prev) => ({
                                ...prev,
                                [request.id]: { ...edit, startsAt: e.target.value },
                              }))
                            }
                          />
                        </Field>
                        <Field label="Until">
                          <input
                            type="datetime-local"
                            value={edit.endsAt}
                            onChange={(e) =>
                              setResourceEdits((prev) => ({
                                ...prev,
                                [request.id]: { ...edit, endsAt: e.target.value },
                              }))
                            }
                          />
                        </Field>
                        <div className="row">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => resubmitResources(request)}
                          >
                            Resubmit resource
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() =>
                              setResourceEdits(({ [request.id]: _removed, ...rest }) => rest)
                            }
                          >
                            Cancel
                          </button>
                        </div>
                        <p className="hint">
                          The new window must stay inside the event's own start and end. If the
                          event itself moved, use “Revise event” instead.
                        </p>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            {canManage ? (
              <div className="row wrap approval-actions">
                <button
                  type="button"
                  disabled={busy || !summary.readyToPublish || event.status === "PUBLISHED"}
                  onClick={publish}
                >
                  <Icon name="check" size={14} /> Publish event
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setReviseOpen(true)}
                >
                  Revise event
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => setCancelOpen(true)}
                >
                  Cancel event
                </button>
              </div>
            ) : (
              <p className="meta">
                Only this event&apos;s club coordinators can revise, publish or cancel it. Your role
                here is to approve, reject, or ask for changes.
              </p>
            )}
            {!summary.readyToPublish && (
              <p className="hint">
                Publishing unlocks when every required permission is approved. Optional requests
                never block it.
              </p>
            )}
            {event.status === "READY" && summary.readyToPublish && (
              <p className="ok-note">Every required approval is in. You can publish now.</p>
            )}
            {open.length === 0 && event.status === "PENDING_APPROVALS" && changes.length === 0 && (
              <p className="warn-note">
                No open requests remain but the event is not ready. An administrator can inspect the
                bundle and decide the next step.
              </p>
            )}
          </section>
        </>
      )}

      <FormDialog
        open={reviseOpen}
        title="Revise this event"
        description="A revision creates a new draft and retires the current approval bundle. You will edit the details, then submit a fresh bundle. Existing approvals do not carry over."
        submitLabel="Create draft revision"
        busy={busy}
        onClose={() => setReviseOpen(false)}
        onSubmit={(e) => {
          e.preventDefault();
          revise();
        }}
      >
        <Field label="What changed?" hint="Recorded in the event history.">
          <textarea
            rows={3}
            maxLength={2000}
            value={reviseNote}
            onChange={(e) => setReviseNote(e.target.value)}
            placeholder="Reviewer asked for a bigger hall and a later start time."
          />
        </Field>
      </FormDialog>

      <FormDialog
        open={cancelOpen}
        title="Cancel this event?"
        description="Resource holds are released and the event closes. This cannot be undone."
        submitLabel="Cancel event"
        danger
        busy={busy}
        onClose={() => setCancelOpen(false)}
        onSubmit={(e) => {
          e.preventDefault();
          cancel();
        }}
      >
        <Field label="Reason" hint="At least 5 characters; shown in the event history.">
          <textarea
            rows={3}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
        </Field>
      </FormDialog>
    </div>
  );
}
