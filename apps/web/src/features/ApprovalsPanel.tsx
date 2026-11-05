import { APPROVAL_TIER_LABELS, APPROVAL_TYPE_LABELS } from "@campusops/shared/ui";
import { useCallback, useEffect, useState } from "react";
import { Modal, useToast } from "../components/feedback";
import {
  ApprovalBadge,
  Card,
  Empty,
  ErrorNote,
  Field,
  ReservationBadge,
  SuccessNote,
  formatWhen,
} from "../components/ui";
import { type Page, api, errorMessage, query } from "../lib/api";
import type { ApprovalRequestRow, Approver, InboxItem, RequestDetail } from "../lib/types";

export function ApprovalsPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [comment, setComment] = useState("");
  const [reassignees, setReassignees] = useState<Approver[]>([]);
  const [reassignTo, setReassignTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A failed decision happens *inside* the dialog. `ErrorNote` lives behind the
  // backdrop, so it cannot carry the message; the toast layer can.
  const toast = useToast();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    // No scope switch: the inbox is already exactly what this person may decide
    // — their named asks plus the shared queue for a tier they hold. Asking them
    // to pick a bucket first was a choice with no wrong answer.
    const page = await api<Page<InboxItem>>(`/approvals/inbox${query({ limit: 50 })}`);
    setInbox(page.items);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(errorMessage(err)));
  }, [load]);

  async function open(request: ApprovalRequestRow) {
    setError(null);
    setNotice(null);
    setComment("");
    try {
      const d = await api<RequestDetail>(`/approval-requests/${request.id}`);
      setDetail(d);
      if (d.request.currentTier === "FACULTY") {
        const list = await api<{ items: Approver[] }>("/approvals/approvers?tier=FACULTY");
        setReassignees(list.items.filter((a) => a.id !== d.request.assignedApproverId));
        setReassignTo("");
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function send(
    action: "decision" | "escalate",
    body: Record<string, unknown>,
    message: string,
  ) {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/approval-requests/${detail.request.id}/${action}`, {
        ...body,
        expectedVersion: detail.request.version,
      });
      setNotice(message);
      setDetail(null);
      await load();
      onChanged?.();
    } catch (err) {
      // No setError here on purpose: the panel's ErrorNote is behind the dialog.
      toast.err(errorMessage(err));
      // A stale version means someone else acted: refresh so the UI is honest.
      try {
        setDetail(await api<RequestDetail>(`/approval-requests/${detail.request.id}`));
      } catch {
        setDetail(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function reassign() {
    if (!detail || !reassignTo) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/approval-requests/${detail.request.id}/reassign`, {
        expectedVersion: detail.request.version,
        assigneeId: reassignTo,
        reason: "Coordinator asked a different faculty member to review this permission.",
      });
      setNotice("Request reassigned. The previous ask stays in the history.");
      setDetail(null);
      await load();
      onChanged?.();
    } catch (err) {
      toast.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorNote message={error} />
      <SuccessNote message={notice} />
      <Card
        title="Approval inbox"
        actions={
          <button
            type="button"
            className="ghost"
            onClick={() => load().catch((e) => setError(errorMessage(e)))}
          >
            Refresh
          </button>
        }
      >
        <p className="scope-help">
          Every request below is one you can decide: the ones addressed to you by name, plus
          unclaimed requests waiting at a tier you hold.
        </p>
        {inbox.length === 0 ? (
          <Empty title="Nothing to decide" icon="check">
            Requests addressed to you, and unclaimed ones at your tier, appear here.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Permission</th>
                  <th>Event</th>
                  <th>Tier</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {inbox.map(({ request, event, club, resourceSummary }) => (
                  <tr key={request.id} data-request-id={request.id}>
                    <td>
                      {request.title}
                      <small className="hint">
                        {APPROVAL_TYPE_LABELS[request.type]}
                        {request.isRequired ? " · required" : " · optional"}
                      </small>
                      {/* Which room or lab this is about. Without it an approval
                          of two identical "Lab booking" rows was a coin toss. */}
                      {resourceSummary ? (
                        <small className="hint resource-line">{resourceSummary}</small>
                      ) : null}
                    </td>
                    <td>
                      {event.title}
                      <small className="hint">
                        {club.name} · {formatWhen(event.startsAt)}
                      </small>
                    </td>
                    <td>{APPROVAL_TIER_LABELS[request.currentTier]}</td>
                    <td>
                      <ApprovalBadge status={request.status} />
                    </td>
                    <td>
                      <button
                        type="button"
                        id={`approval-review-${request.id}`}
                        aria-label={`Review ${request.title}`}
                        onClick={() => open(request)}
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={detail !== null}
        size="lg"
        title={detail?.request.title ?? "Approval"}
        description={
          detail ? (
            <>
              {detail.event.title} · {detail.club.name} · awaiting{" "}
              {APPROVAL_TIER_LABELS[detail.request.currentTier]} · version {detail.request.version}
            </>
          ) : undefined
        }
        busy={busy}
        onClose={() => setDetail(null)}
        footer={
          <>
            {detail?.request.status === "PENDING" && (
              <>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => send("decision", { action: "REJECT", comment }, "Rejected.")}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    send(
                      "decision",
                      { action: "REQUEST_CHANGES", comment },
                      "Sent back for changes.",
                    )
                  }
                >
                  Request changes
                </button>
                {detail.request.currentTier !== "ADMIN" && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() =>
                      send(
                        "escalate",
                        {
                          toTier: detail.request.currentTier === "FACULTY" ? "SENIOR" : "ADMIN",
                          comment,
                        },
                        `Escalated to ${detail.request.currentTier === "FACULTY" ? "HOD/Dean" : "Admin"}.`,
                      )
                    }
                  >
                    Escalate to {detail.request.currentTier === "FACULTY" ? "HOD/Dean" : "Admin"}
                  </button>
                )}
              </>
            )}
            <button type="button" className="ghost" disabled={busy} onClick={() => setDetail(null)}>
              Close
            </button>
            {detail?.request.status === "PENDING" && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  send(
                    "decision",
                    { action: "APPROVE", ...(comment ? { comment } : {}) },
                    "Approved.",
                  )
                }
              >
                Approve
              </button>
            )}
          </>
        }
      >
        {detail && (
          <>
            {detail.request.description && <p>{detail.request.description}</p>}

            {detail.resources.length > 0 && (
              <div className="resources">
                <h3>Resources in this permission</h3>
                {detail.resources.map((r) => (
                  <p key={r.unit.id} className="meta">
                    {r.resource.name} — {r.unit.label} · {formatWhen(r.link.startsAt)} –{" "}
                    {formatWhen(r.link.endsAt)}
                  </p>
                ))}
                <div className="row">
                  {detail.reservations.map((r) => (
                    <span key={r.id} className="row">
                      <ReservationBadge status={r.status} />
                      {r.holdExpiresAt && (
                        <small className="hint">hold until {formatWhen(r.holdExpiresAt)}</small>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {detail.request.status === "PENDING" && (
              <>
                <Field
                  label="Comment"
                  hint="Required when rejecting, requesting changes, or escalating."
                >
                  <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
                </Field>
                {detail.request.currentTier === "FACULTY" && reassignees.length > 0 && (
                  <div className="row">
                    <select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                      <option value="">Ask another faculty instead…</option>
                      {reassignees.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.fullName}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || !reassignTo}
                      onClick={reassign}
                    >
                      Reassign
                    </button>
                  </div>
                )}
              </>
            )}

            <h3>History</h3>
            <ol className="timeline">
              {detail.actions.map(({ action, actor }) => (
                <li key={action.id}>
                  <strong>{action.action}</strong> · {actor.fullName}
                  {action.toTier && <span> → {APPROVAL_TIER_LABELS[action.toTier]}</span>}
                  {action.comment && <p className="meta">“{action.comment}”</p>}
                  <small className="hint">
                    {formatWhen(action.createdAt)} · v{action.requestVersion}
                  </small>
                </li>
              ))}
            </ol>
          </>
        )}
      </Modal>
    </>
  );
}
