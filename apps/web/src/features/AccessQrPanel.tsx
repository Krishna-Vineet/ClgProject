import {
  ACCESS_DENY_LABELS,
  type AccessDenyReason,
  QR_TYPES,
  QR_TYPE_HINTS,
  QR_TYPE_LABELS,
  QR_VALIDITY_HINTS,
  QR_VALIDITY_LABELS,
  QR_VALIDITY_MODES,
  type QrType,
  type QrValidityMode,
  qrTypeNeedsMaxUses,
} from "@campusops/shared/ui";
import { useCallback, useEffect, useState } from "react";
import {
  ConfirmDialog,
  FormDialog,
  Loading,
  Pager,
  useAction,
  useToast,
} from "../components/feedback";
import {
  Empty,
  Field,
  formatWhen,
  fromLocalInput,
  toLocalInput,
  useNotice,
} from "../components/ui";
import { type Page, api, errorMessage, query } from "../lib/api";
import { PAGE_SIZE } from "../lib/constants";
import type { EventRow } from "../lib/types";

type Checkpoint = {
  id: string;
  name: string;
  qrType: QrType;
  maxUses: number | null;
  validityMode: QrValidityMode;
  startsAt: string | null;
  endsAt: string | null;
  validOn: string | null;
  requiresIdCheck: boolean;
  isActive: boolean;
  uses: number;
  people: number;
  denied: number;
};

type PassHolder = {
  passId: string;
  revokedAt: string | null;
  status: string;
  user: { id: string; fullName: string; email: string };
  uses: number;
};

type LogEntry = {
  id: string;
  result: "GRANTED" | "DENIED";
  reason: string | null;
  identityCheck: string;
  createdAt: string;
  checkpointId: string | null;
  checkpointName: string | null;
  scanner: { id: string; fullName: string };
  participantId: string | null;
  participantName: string | null;
  participantPhone: string | null;
  participantEmail: string | null;
};

type Form = {
  name: string;
  qrType: QrType;
  maxUses: number;
  validityMode: QrValidityMode;
  validFrom: string;
  validUntil: string;
  validOn: string;
  requiresIdCheck: boolean;
  isActive: boolean;
};

function blankForm(event: EventRow): Form {
  return {
    name: "",
    qrType: "ONE_TIME",
    maxUses: 2,
    validityMode: "WINDOW",
    validFrom: toLocalInput(new Date(event.startsAt)),
    validUntil: toLocalInput(new Date(event.endsAt)),
    validOn: toLocalInput(new Date(event.startsAt)).slice(0, 10),
    requiresIdCheck: true,
    isActive: true,
  };
}

function editForm(cp: Checkpoint, event: EventRow): Form {
  return {
    ...blankForm(event),
    name: cp.name,
    qrType: cp.qrType,
    maxUses: cp.maxUses ?? 2,
    validityMode: cp.validityMode,
    ...(cp.startsAt ? { validFrom: toLocalInput(new Date(cp.startsAt)) } : {}),
    ...(cp.endsAt ? { validUntil: toLocalInput(new Date(cp.endsAt)) } : {}),
    ...(cp.validOn ? { validOn: cp.validOn } : {}),
    requiresIdCheck: cp.requiresIdCheck,
    isActive: cp.isActive,
  };
}

function ruleBody(form: Form) {
  return {
    name: form.name.trim(),
    qrType: form.qrType,
    maxUses: qrTypeNeedsMaxUses(form.qrType) ? Number(form.maxUses) : null,
    validityMode: form.validityMode,
    validFrom: form.validityMode === "WINDOW" ? fromLocalInput(form.validFrom) : null,
    validUntil: form.validityMode === "WINDOW" ? fromLocalInput(form.validUntil) : null,
    validOn: form.validityMode === "DATE" ? form.validOn : null,
    requiresIdCheck: form.requiresIdCheck,
    isActive: form.isActive,
  };
}

function validityText(cp: Checkpoint): string {
  if (cp.validityMode === "MANUAL") return "Only while switched on";
  if (cp.validityMode === "DATE") return `On ${cp.validOn ?? "no date set"} (campus day)`;
  return `${cp.startsAt ? formatWhen(cp.startsAt) : "—"} → ${cp.endsAt ? formatWhen(cp.endsAt) : "—"}`;
}

/** A misconfigured rule is worse than no rule: it refuses every scan silently. */
function ruleProblem(cp: Checkpoint): string | null {
  if (cp.validityMode === "DATE" && !cp.validOn)
    return "No campus day is set, so every scan will be refused.";
  if (cp.validityMode === "WINDOW") {
    if (!cp.startsAt || !cp.endsAt)
      return "The time window is incomplete, so scans will be refused.";
    if (new Date(cp.endsAt).getTime() <= new Date(cp.startsAt).getTime())
      return "The window ends before it starts, so scans will be refused.";
  }
  return null;
}

function formProblem(form: Form): string | null {
  if (!form.name.trim()) return "Give this QR a name participants will recognise.";
  if (qrTypeNeedsMaxUses(form.qrType) && (!Number.isInteger(form.maxUses) || form.maxUses < 1))
    return "Valid uses must be a whole number of at least 1.";
  if (form.validityMode === "DATE" && !form.validOn)
    return "Choose the campus day this QR is valid on.";
  if (form.validityMode === "WINDOW") {
    if (!form.validFrom || !form.validUntil) return "Set both ends of the time window.";
    if (new Date(form.validUntil).getTime() <= new Date(form.validFrom).getTime())
      return "The window must end after it starts.";
  }
  return null;
}

function reasonLabel(reason: string | null): string {
  if (!reason || reason === "OK") return "—";
  if (reason in ACCESS_DENY_LABELS) return ACCESS_DENY_LABELS[reason as AccessDenyReason];
  if (reason === "QR_INVALID") return "Code could not be read";
  if (reason === "PASS_NOT_FOUND") return "No pass matches this code";
  return reason.replace(/_/g, " ").toLowerCase();
}

/**
 * Coordinators define every QR here: its name, what a scan does, and when it is
 * accepted. There is no purpose taxonomy. The participant app reads these same
 * rules; scanning is done by the event's coordinators and club faculty on mobile.
 */
export function AccessQrPanel({ event, canManage }: { event: EventRow; canManage: boolean }) {
  const toast = useToast();
  const action = useAction();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [holders, setHolders] = useState<PassHolder[] | null>(null);
  const [log, setLog] = useState<Page<LogEntry> | null>(null);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState({ checkpointId: "", result: "" });
  const [error, setError] = useState<string | null>(null);
  // Action results are toasts; only a standing condition stays on the page.
  useNotice(error, null);
  const [form, setForm] = useState<Form>(() => blankForm(event));
  const [editing, setEditing] = useState<Checkpoint | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Checkpoint | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<PassHolder | null>(null);
  const [view, setView] = useState<"qrs" | "passes" | "log">("qrs");

  const loadCheckpoints = useCallback(async () => {
    const data = await api<{ items: Checkpoint[] }>(`/events/${event.id}/checkpoints`);
    setCheckpoints(data.items);
  }, [event.id]);
  const loadHolders = useCallback(async () => {
    const data = await api<{ items: PassHolder[] }>(`/events/${event.id}/passes`);
    setHolders(data.items);
  }, [event.id]);
  const loadLog = useCallback(async () => {
    const data = await api<Page<LogEntry>>(
      `/events/${event.id}/access-log${query({ limit: PAGE_SIZE, offset, checkpointId: filter.checkpointId || undefined, result: filter.result || undefined })}`,
    );
    setLog(data);
  }, [event.id, offset, filter.checkpointId, filter.result]);
  const loadAll = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([loadCheckpoints(), loadHolders(), loadLog()]);
    } catch (err) {
      setError(errorMessage(err));
      setCheckpoints((c) => c ?? []);
      setHolders((h) => h ?? []);
    }
  }, [loadCheckpoints, loadHolders, loadLog]);
  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function submit() {
    const problem = formProblem(form);
    if (problem) {
      toast.err(problem);
      return;
    }
    const ok = await action.run(async () => {
      if (editing) {
        await api(`/access/checkpoints/${editing.id}`, ruleBody(form), { method: "PATCH" });
        return "QR rule updated. Participants see the change on their next refresh.";
      }
      await api(`/events/${event.id}/checkpoints`, ruleBody(form), { method: "POST" });
      return "QR added. It is now visible to confirmed participants.";
    });
    if (ok) {
      setEditing(null);
      setForm(blankForm(event));
      setFormOpen(false);
      await loadCheckpoints();
    }
  }

  async function toggle(cp: Checkpoint) {
    const ok = await action.run(async () => {
      await api(
        `/access/checkpoints/${cp.id}/active`,
        { isActive: !cp.isActive },
        { method: "PATCH" },
      );
      return `${cp.name} is now ${cp.isActive ? "off" : "on"}.`;
    });
    if (ok) await loadCheckpoints();
  }

  async function issuePasses() {
    const ok = await action.run(async () => {
      const res = await api<{ created: number; confirmed: number }>(
        `/events/${event.id}/passes/issue`,
        {},
        { method: "POST" },
      );
      return res.created === 0
        ? `All ${res.confirmed} confirmed participants already have a pass.`
        : `Issued ${res.created} new pass${res.created === 1 ? "" : "es"}.`;
    });
    if (ok) await loadHolders();
  }

  const typeLocked = Boolean(editing && editing.uses > 0);
  return (
    <>
      <div className="subtabs">
        {(
          [
            ["qrs", "QR rules"],
            ["passes", "Passes"],
            ["log", "Scan log"],
          ] as Array<[typeof view, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            id={`qr-view-${key}`}
            data-action="select-view"
            aria-pressed={view === key}
            className={view === key ? "active" : "ghost"}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "qrs" && (
        <>
          <div className="row between" style={{ marginBottom: 12 }}>
            <p className="meta" style={{ margin: 0 }}>
              Name each QR whatever you need. Choose what one scan does and when it is accepted. A
              scan is only accepted while the event is live; the on/off switch pauses a QR
              immediately.
            </p>
            {canManage && (
              <button
                type="button"
                id="qr-new"
                data-action="new-qr"
                onClick={() => {
                  setEditing(null);
                  setForm(blankForm(event));
                  setFormOpen(true);
                }}
              >
                New QR
              </button>
            )}
          </div>
          {event.status !== "LIVE" && (
            <p className="warn-note">
              This event is {event.status.replace(/_/g, " ").toLowerCase()}, not live. Every scan is
              refused with &ldquo;event is not live&rdquo; until a coordinator starts it.
            </p>
          )}
          {!checkpoints ? (
            <Loading label="Loading QR rules…" />
          ) : checkpoints.length === 0 ? (
            <Empty>No access QRs yet. Define the first one below.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="grid">
                <thead>
                  <tr>
                    <th>QR name</th>
                    <th>Type</th>
                    <th>Validity</th>
                    <th>ID check</th>
                    <th>Scans · people</th>
                    <th>Switch</th>
                    {canManage && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {checkpoints.map((cp) => (
                    // Each row owns its own buttons. They used to be three
                    // identical <button> elements repeated per row, so every switch,
                    // every Edit and every Delete on the page was indistinguishable
                    // to a test, a screen reader's element list, and anything else
                    // that addresses a control by identity. The id is the row's key.
                    <tr key={cp.id} data-checkpoint-id={cp.id}>
                      <td>{cp.name}</td>
                      <td>
                        {QR_TYPE_LABELS[cp.qrType]}
                        {cp.qrType === "COUNTED" ? ` · ${cp.maxUses}` : ""}
                      </td>
                      <td className="meta">
                        {validityText(cp)}
                        {ruleProblem(cp) && <span className="field-warn">{ruleProblem(cp)}</span>}
                      </td>
                      <td>{cp.requiresIdCheck ? "Required" : "Not required"}</td>
                      <td>
                        {cp.uses} scans · {cp.people} people
                        {cp.denied > 0 ? (
                          <span className="meta"> · {cp.denied} refused</span>
                        ) : null}
                      </td>
                      <td>
                        <span className={`badge ${cp.isActive ? "good" : "muted"}`}>
                          {cp.isActive ? "On" : "Off"}
                        </span>
                      </td>
                      {canManage && (
                        <td>
                          <div className="row">
                            <button
                              type="button"
                              id={`qr-toggle-${cp.id}`}
                              data-action="toggle-qr"
                              className="ghost tiny"
                              aria-label={`${cp.isActive ? "Switch off" : "Switch on"} ${cp.name}`}
                              disabled={action.busy}
                              onClick={() => void toggle(cp)}
                            >
                              {cp.isActive ? "Switch off" : "Switch on"}
                            </button>
                            <button
                              type="button"
                              id={`qr-edit-${cp.id}`}
                              data-action="edit-qr"
                              className="ghost tiny"
                              aria-label={`Edit ${cp.name}`}
                              onClick={() => {
                                setEditing(cp);
                                setForm(editForm(cp, event));
                                setFormOpen(true);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              id={`qr-delete-${cp.id}`}
                              data-action="delete-qr"
                              className="ghost tiny"
                              aria-label={`Delete ${cp.name}`}
                              onClick={() => setConfirmDelete(cp)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="qr-legend">
            <h4>What one scan does</h4>
            <ul className="plain hint">
              {QR_TYPES.map((type) => (
                <li key={type}>
                  <strong>{QR_TYPE_LABELS[type]}</strong> — {QR_TYPE_HINTS[type]}
                </li>
              ))}
            </ul>
            <p className="meta">
              Validity narrows when a code is accepted; the on/off switch pauses it in every mode.
              All times use the campus timezone.
            </p>
          </div>

          {!canManage && (
            <p className="meta">
              Only this event&apos;s coordinators can change its QR rules. You can still see how
              they are configured and used.
            </p>
          )}
        </>
      )}

      <FormDialog
        open={formOpen}
        title={editing ? `Edit ${editing.name}` : "Define a QR"}
        description="One QR, one purpose. The on/off switch works in every mode."
        submitLabel={editing ? "Save QR rule" : "Add QR"}
        size="lg"
        busy={action.busy}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setForm(blankForm(event));
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (form.name.trim().length === 0) return;
          void submit();
        }}
      >
        <div className="grid-2">
          <Field
            label="QR name"
            hint="Free text, up to 80 characters. This is what participants see."
          >
            <input
              value={form.name}
              maxLength={80}
              placeholder="e.g. Attendance, Lab 3, abc"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field
            label="QR type"
            hint={
              typeLocked
                ? "This QR has recorded scans, so its type is fixed. Create another QR for a different type."
                : QR_TYPE_HINTS[form.qrType]
            }
          >
            <select
              value={form.qrType}
              disabled={typeLocked}
              onChange={(e) => setForm({ ...form, qrType: e.target.value as QrType })}
            >
              {QR_TYPES.map((t) => (
                <option key={t} value={t}>
                  {QR_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          {qrTypeNeedsMaxUses(form.qrType) && (
            <Field
              label="Valid uses per participant"
              hint="Counted across this event. You can raise it later, but not below what someone has already used."
            >
              <input
                type="number"
                min={1}
                max={1000}
                value={form.maxUses}
                onChange={(e) => setForm({ ...form, maxUses: Number(e.target.value) })}
              />
            </Field>
          )}
          <Field label="Validity" hint={QR_VALIDITY_HINTS[form.validityMode]}>
            <select
              value={form.validityMode}
              onChange={(e) => setForm({ ...form, validityMode: e.target.value as QrValidityMode })}
            >
              {QR_VALIDITY_MODES.map((m) => (
                <option key={m} value={m}>
                  {QR_VALIDITY_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          {form.validityMode === "WINDOW" && (
            <>
              <Field label="Valid from">
                <input
                  type="datetime-local"
                  value={form.validFrom}
                  onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
                />
              </Field>
              <Field label="Valid until">
                <input
                  type="datetime-local"
                  value={form.validUntil}
                  onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                />
              </Field>
            </>
          )}
          {form.validityMode === "DATE" && (
            <Field label="Valid on" hint="The whole calendar day in the campus timezone.">
              <input
                type="date"
                value={form.validOn}
                onChange={(e) => setForm({ ...form, validOn: e.target.value })}
              />
            </Field>
          )}
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.requiresIdCheck}
            onChange={(e) => setForm({ ...form, requiresIdCheck: e.target.checked })}
          />
          Scanner must confirm the person matches their college ID
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
          QR is switched on
        </label>
      </FormDialog>

      {view === "passes" && (
        <>
          <p className="meta">
            One pass per confirmed participant. Issuing is safe to repeat — it only creates passes
            for people who do not have one yet.
          </p>
          {canManage && (
            <div className="row">
              <button type="button" disabled={action.busy} onClick={() => void issuePasses()}>
                Issue passes to confirmed participants
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void loadHolders().catch((e) => toast.err(errorMessage(e)))}
              >
                Refresh
              </button>
            </div>
          )}
          {!holders ? (
            <Loading label="Loading passes…" />
          ) : holders.length === 0 ? (
            <Empty>No passes yet. Confirm registrations, then issue passes.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Participant</th>
                    <th>Email</th>
                    <th>Registration</th>
                    <th>Total scans</th>
                    <th>Pass</th>
                    {canManage && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {holders.map((h) => (
                    <tr key={h.passId} data-pass-id={h.passId}>
                      <td>{h.user.fullName}</td>
                      <td className="meta">{h.user.email}</td>
                      <td>{h.status.replace(/_/g, " ").toLowerCase()}</td>
                      <td>{h.uses}</td>
                      <td>
                        <span className={`badge ${h.revokedAt ? "bad" : "good"}`}>
                          {h.revokedAt ? "Revoked" : "Active"}
                        </span>
                      </td>
                      {canManage && (
                        <td>
                          {!h.revokedAt && (
                            <button
                              type="button"
                              id={`pass-revoke-${h.passId}`}
                              data-action="revoke-pass"
                              className="ghost tiny"
                              aria-label={`Revoke the pass for ${h.user.fullName}`}
                              onClick={() => setConfirmRevoke(h)}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {view === "log" && (
        <>
          <div className="grid-2">
            <Field label="QR">
              <select
                value={filter.checkpointId}
                onChange={(e) => {
                  setOffset(0);
                  setFilter({ ...filter, checkpointId: e.target.value });
                }}
              >
                <option value="">All QRs</option>
                {(checkpoints ?? []).map((cp) => (
                  <option key={cp.id} value={cp.id}>
                    {cp.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Outcome">
              <select
                value={filter.result}
                onChange={(e) => {
                  setOffset(0);
                  setFilter({ ...filter, result: e.target.value });
                }}
              >
                <option value="">All outcomes</option>
                <option value="GRANTED">Granted</option>
                <option value="DENIED">Denied</option>
              </select>
            </Field>
          </div>
          {!log ? (
            <Loading label="Loading scans…" />
          ) : log.items.length === 0 ? (
            <Empty>Nothing scanned yet.</Empty>
          ) : (
            <>
              <div className="scroll-x">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>QR</th>
                      <th>Participant</th>
                      <th>Phone</th>
                      <th>Outcome</th>
                      <th>Detail</th>
                      <th>Scanned by</th>
                      <th>ID check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.items.map((entry) => (
                      <tr key={entry.id} data-scan-id={entry.id}>
                        <td className="meta">{formatWhen(entry.createdAt)}</td>
                        <td>{entry.checkpointName ?? "—"}</td>
                        {/* A scan log is a record of people, not of codes: "who was
                            this?" is the first question anyone asks at the gate, and
                            it was the one column the table did not have. */}
                        <td>
                          {entry.participantName ?? <span className="meta">Unknown</span>}
                          {entry.participantName && entry.participantEmail ? (
                            <span className="cell-sub">{entry.participantEmail}</span>
                          ) : null}
                        </td>
                        <td className="mono">
                          {entry.participantPhone ? (
                            <a href={`tel:${entry.participantPhone}`}>{entry.participantPhone}</a>
                          ) : (
                            <span className="meta">No number on file</span>
                          )}
                        </td>
                        <td>
                          <span className={`badge ${entry.result === "GRANTED" ? "good" : "bad"}`}>
                            {entry.result === "GRANTED" ? "Granted" : "Denied"}
                          </span>
                        </td>
                        <td className="meta">{reasonLabel(entry.reason)}</td>
                        <td>{entry.scanner.fullName}</td>
                        <td className="meta">
                          {entry.identityCheck === "NOT_REQUIRED"
                            ? "Not required"
                            : entry.identityCheck === "MATCH"
                              ? "Matched"
                              : "Did not match"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                offset={offset}
                limit={PAGE_SIZE}
                count={log.items.length}
                hasMore={log.hasMore}
                onChange={setOffset}
              />
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete ${confirmDelete?.name ?? ""}?`}
        description="Only QRs with no scans can be deleted. If people have already used it, switch it off instead so the record survives."
        confirmLabel="Delete QR"
        busy={action.busy}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete;
          if (!target) return;
          void action
            .run(async () => {
              await api(`/access/checkpoints/${target.id}`, undefined, { method: "DELETE" });
              return "QR deleted.";
            })
            .then(async (ok) => {
              setConfirmDelete(null);
              if (ok) await loadCheckpoints();
            });
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmRevoke)}
        title={`Revoke the pass for ${confirmRevoke?.user.fullName ?? ""}?`}
        description="Every QR will refuse this participant from now on. The scans already recorded are kept."
        confirmLabel="Revoke pass"
        busy={action.busy}
        onCancel={() => setConfirmRevoke(null)}
        onConfirm={() => {
          const target = confirmRevoke;
          if (!target) return;
          void action
            .run(async () => {
              await api(`/access/passes/${target.passId}/revoke`, {}, { method: "POST" });
              return "Pass revoked.";
            })
            .then(async (ok) => {
              setConfirmRevoke(null);
              if (ok) await loadHolders();
            });
        }}
      />
    </>
  );
}
