import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, Loading, Pager, useAction, useToast } from "../components/feedback";
import { Card, Empty, ErrorNote, Field, formatWhen } from "../components/ui";
import { type Page, api, downloadBlob, errorMessage, query } from "../lib/api";
import { PAGE_SIZE } from "../lib/constants";
import type { EventRow } from "../lib/types";

type Row = {
  /** The registration id (the API spreads the registration row). */
  id: string;
  fullName: string;
  email: string;
  accountType: string;
  status: string;
  appliedAt: string;
  decidedAt: string | null;
  queuePosition: number | null;
  cancelledAt: string | null;
  passId: string | null;
  passRevokedAt: string | null;
  checkedInAt: string | null;
};

type Totals = {
  total: number;
  confirmed: number;
  waitlisted: number;
  applied: number;
  cancelled: number;
  rejected: number;
};

const STATUSES = [
  ["", "All statuses"],
  ["CONFIRMED", "Confirmed"],
  ["WAITLISTED", "Waitlisted"],
  ["APPLIED", "Awaiting decision"],
  ["REJECTED", "Rejected"],
  ["CANCELLED", "Withdrawn"],
] as const;

const badgeFor = (status: string) =>
  status === "CONFIRMED"
    ? "good"
    : status === "WAITLISTED"
      ? "warn"
      : status === "APPLIED"
        ? "info"
        : "bad";

/**
 * The working participant list for an event. For MANUAL admission this is where
 * applications are decided; for every mode it is where a coordinator can see who
 * holds a seat, release one, or check a pass.
 */
export function RosterPanel({ event, canManage }: { event: EventRow; canManage: boolean }) {
  const action = useAction();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<(Totals & { capacity: number }) | null>(null);
  // The workspace paginates by offset everywhere; the roster API takes a page.
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [decide, setDecide] = useState<{ row: Row; decision: "CONFIRMED" | "REJECTED" } | null>(
    null,
  );
  const [remove, setRemove] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<
        Page<Row> & { totals: Totals; capacity: number; admissionMode: string }
      >(
        `/events/${event.id}/registrations${query({
          limit: PAGE_SIZE,
          offset,
          status: status || undefined,
          q: applied || undefined,
        })}`,
      );
      setRows(data.items);
      setTotal(data.totals.total);
      setTotals({ ...data.totals, capacity: data.capacity });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [event.id, offset, status, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="stack">
      <ErrorNote message={error} />

      {totals && (
        <div className="stat-grid">
          {(
            [
              ["Confirmed", totals.confirmed, `${totals.capacity} seats`],
              ["Waitlisted", totals.waitlisted, "next in line"],
              [
                "Awaiting decision",
                totals.applied,
                event.admissionMode === "MANUAL"
                  ? "needs your decision"
                  : event.admissionMode.startsWith("QUIZ")
                    ? "seat comes from the quiz"
                    : "pending",
              ],
              ["Withdrawn", totals.cancelled, "released their place"],
            ] as Array<[string, number, string]>
          ).map(([label, value, sub]) => (
            <div className="stat-card" key={label}>
              <div className="stat-top">
                <span className="stat-label">{label}</span>
              </div>
              <div className="stat-value">{value}</div>
              <div className="stat-sub">{sub}</div>
            </div>
          ))}
        </div>
      )}

      <Card
        title="Participants"
        actions={
          <button
            type="button"
            className="ghost"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                try {
                  await downloadBlob(
                    `/events/${event.id}/registrations.csv`,
                    `${event.slug}-participants.csv`,
                  );
                  return "Roster exported.";
                } catch (err) {
                  toast.err(errorMessage(err));
                  return undefined;
                }
              })
            }
          >
            Export CSV
          </button>
        }
      >
        <form
          className="row"
          style={{ flexWrap: "wrap", marginBottom: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied(search.trim());
          }}
        >
          <Field label="Search name, email or roll number">
            <input
              value={search}
              placeholder="Type to search"
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setOffset(0);
              }}
            >
              {STATUSES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className="ghost">
            Search
          </button>
        </form>

        {loading ? (
          <Loading label="Loading participants…" />
        ) : rows.length === 0 ? (
          <Empty>No participants match this view.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Registered</th>
                  <th>Pass</th>
                  <th>Checked in</th>
                  {canManage && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-registration-id={r.id}>
                    <td>
                      {r.fullName}
                      <div className="meta">{r.email}</div>
                    </td>
                    <td>
                      <span className="meta">
                        {r.accountType === "OUTSIDER_STUDENT" ? "Outsider" : "College student"}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${badgeFor(r.status)}`}>
                        {r.status === "APPLIED" ? "Awaiting decision" : r.status.toLowerCase()}
                      </span>
                      {r.queuePosition !== null && (
                        <div className="meta">queue #{r.queuePosition}</div>
                      )}
                    </td>
                    <td>{formatWhen(r.appliedAt)}</td>
                    <td>
                      {r.passId ? (
                        r.passRevokedAt ? (
                          <span className="badge bad">Revoked</span>
                        ) : (
                          <span className="badge good">Issued</span>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{r.checkedInAt ? formatWhen(r.checkedInAt) : "—"}</td>
                    {canManage && (
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                          {/* A pending application must always be actionable. This
                              used to render only for MANUAL events, but outsiders on
                              any other-college audience are held as APPLIED too — so
                              their row said "Awaiting decision" with no way to decide.
                              Same condition as the API's decideApplication. */}
                          {r.status === "APPLIED" &&
                            (event.admissionMode === "MANUAL" ||
                              event.audience !== "COLLEGE_ONLY") && (
                              <>
                                <button
                                  type="button"
                                  id={`roster-approve-${r.id}`}
                                  aria-label={`Approve ${r.fullName}`}
                                  disabled={action.busy}
                                  onClick={() => setDecide({ row: r, decision: "CONFIRMED" })}
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  id={`roster-reject-${r.id}`}
                                  aria-label={`Reject ${r.fullName}`}
                                  className="ghost"
                                  disabled={action.busy}
                                  onClick={() => setDecide({ row: r, decision: "REJECTED" })}
                                >
                                  Reject
                                </button>
                              </>
                            )}
                          {(r.status === "CONFIRMED" || r.status === "WAITLISTED") && (
                            <button
                              type="button"
                              className="ghost"
                              disabled={action.busy}
                              onClick={() => setRemove(r)}
                            >
                              Release place
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          offset={offset}
          limit={PAGE_SIZE}
          count={rows.length}
          hasMore={offset + rows.length < total}
          onChange={setOffset}
        />
        {(event.admissionMode === "MANUAL" || event.audience !== "COLLEGE_ONLY") && (
          <p className="meta">
            Approving beyond capacity places the applicant on the waitlist instead of overbooking.
            Each decision is recorded against your account.
            {event.audience !== "COLLEGE_ONLY" &&
              " Visitors from other colleges always arrive as applications, whatever the seat allocation."}
          </p>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(decide)}
        title={
          decide?.decision === "CONFIRMED"
            ? `Approve ${decide?.row.fullName ?? ""}?`
            : `Reject ${decide?.row.fullName ?? ""}?`
        }
        description={
          decide?.decision === "CONFIRMED"
            ? "They get a seat if one is free, otherwise the next place on the waitlist. A QR pass is issued automatically."
            : "They will not get a seat. Record why, so the decision is explainable later."
        }
        confirmLabel={decide?.decision === "CONFIRMED" ? "Approve" : "Reject"}
        danger={decide?.decision === "REJECTED"}
        busy={action.busy}
        reasonLabel="Reason (optional)"
        onCancel={() => setDecide(null)}
        onConfirm={(reason) => {
          const target = decide;
          if (!target) return;
          void action
            .run(async () => {
              await api(
                `/events/${event.id}/registrations/${target.row.id}/decision`,
                { decision: target.decision, ...(reason ? { note: reason } : {}) },
                { method: "POST" },
              );
              return target.decision === "CONFIRMED"
                ? "Application approved."
                : "Application rejected.";
            })
            .then(async (ok) => {
              setDecide(null);
              if (ok) await load();
            });
        }}
      />

      <ConfirmDialog
        open={Boolean(remove)}
        title={`Release the place held by ${remove?.fullName ?? ""}?`}
        description="Their QR pass is revoked and the next person on the waitlist is promoted automatically. The registration record is kept."
        confirmLabel="Release place"
        busy={action.busy}
        reasonLabel="Reason (optional)"
        onCancel={() => setRemove(null)}
        onConfirm={(reason) => {
          const target = remove;
          if (!target) return;
          void action
            .run(async () => {
              await api(
                `/events/${event.id}/registrations/${target.id}/remove`,
                reason ? { reason } : {},
                { method: "POST" },
              );
              return "Place released.";
            })
            .then(async (ok) => {
              setRemove(null);
              if (ok) await load();
            });
        }}
      />
    </div>
  );
}
