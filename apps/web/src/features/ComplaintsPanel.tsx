import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_CATEGORY_LABELS,
  COMPLAINT_STATUSES,
  COMPLAINT_STATUS_LABELS,
  type ComplaintStatus,
} from "@campusops/shared/ui";
import { useCallback, useEffect, useState } from "react";
import { Loading, Pager, useAction } from "../components/feedback";
import { Empty, ErrorNote, Field, formatWhen } from "../components/ui";
import { type Page, api, downloadBlob, errorMessage, query } from "../lib/api";
import { PAGE_SIZE } from "../lib/constants";
import type { EventRow } from "../lib/types";

type Location = {
  id: string;
  label: string;
  description: string | null;
  revokedAt: string | null;
  open: number;
  total: number;
};

type Complaint = {
  id: string;
  category: keyof typeof COMPLAINT_CATEGORY_LABELS;
  description: string;
  status: ComplaintStatus;
  assignedTo: string | null;
  resolvedAt: string | null;
  createdAt: string;
  locationId: string | null;
  locationLabel: string | null;
  reporter: { id: string; fullName: string; email: string };
};

type Update = {
  update: {
    id: string;
    fromStatus: ComplaintStatus | null;
    toStatus: ComplaintStatus | null;
    note: string | null;
    createdAt: string;
  };
  actor: { id: string; fullName: string };
};

const STATUS_TONE: Record<ComplaintStatus, string> = {
  OPEN: "warn",
  ASSIGNED: "info",
  IN_PROGRESS: "info",
  RESOLVED: "good",
  CLOSED: "muted",
};

/**
 * Reporting points and the issues raised at them.
 *
 * A coordinator creates a point for a real spot — the sound desk, the food
 * counter, an ad-hoc corner — downloads its QR poster and puts it up. Students
 * scan it in the app; reports land here and nowhere else, because they belong to
 * this event's organisers.
 */
export function ComplaintsPanel({ event, canManage }: { event: EventRow; canManage: boolean }) {
  const action = useAction();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [complaints, setComplaints] = useState<Page<Complaint> | null>(null);
  const [summary, setSummary] = useState<{
    byStatus: Record<string, number>;
    activeLocations: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState({ status: "", locationId: "" });
  const [view, setView] = useState<"inbox" | "points">("inbox");
  const [form, setForm] = useState({ label: "", description: "" });
  const [editing, setEditing] = useState<Location | null>(null);
  const [open, setOpen] = useState<Complaint | null>(null);
  const [trail, setTrail] = useState<Update[] | null>(null);
  const [decision, setDecision] = useState<{ status: ComplaintStatus; note: string }>({
    status: "IN_PROGRESS",
    note: "",
  });

  const loadLocations = useCallback(async () => {
    const data = await api<{ items: Location[] }>(`/events/${event.id}/complaint-locations`);
    setLocations(data.items);
  }, [event.id]);

  const loadInbox = useCallback(async () => {
    const [list, counts] = await Promise.all([
      api<Page<Complaint>>(
        `/events/${event.id}/complaints${query({
          limit: PAGE_SIZE,
          offset,
          status: filter.status || undefined,
          locationId: filter.locationId || undefined,
        })}`,
      ),
      api<{ byStatus: Record<string, number>; activeLocations: number }>(
        `/events/${event.id}/complaints/summary`,
      ),
    ]);
    setComplaints(list);
    setSummary(counts);
  }, [event.id, offset, filter.status, filter.locationId]);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([loadLocations(), loadInbox()]);
    } catch (err) {
      setError(errorMessage(err));
      setLocations((l) => l ?? []);
    }
  }, [loadLocations, loadInbox]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function openComplaint(item: Complaint) {
    setOpen(item);
    setTrail(null);
    setDecision({ status: item.status === "OPEN" ? "IN_PROGRESS" : item.status, note: "" });
    try {
      const data = await api<{ updates: Update[] }>(`/complaints/${item.id}`);
      setTrail(data.updates);
    } catch (err) {
      setError(errorMessage(err));
      setTrail([]);
    }
  }

  async function saveLocation() {
    const ok = await action.run(async () => {
      const body = {
        label: form.label.trim(),
        description: form.description.trim() ? form.description.trim() : null,
      };
      if (editing) {
        await api(`/complaints/locations/${editing.id}`, body, { method: "PATCH" });
        return "Reporting point updated.";
      }
      await api(`/events/${event.id}/complaint-locations`, body, { method: "POST" });
      return "Reporting point created. Download its poster and put it up.";
    });
    if (ok) {
      setEditing(null);
      setForm({ label: "", description: "" });
      await loadLocations();
    }
  }

  async function download(location: Location) {
    await action.run(async () => {
      const safeName = location.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      await downloadBlob(
        `/complaints/locations/${location.id}/poster`,
        `report-issue-${safeName || location.id.slice(0, 8)}.pdf`,
      );
      return "Poster downloaded.";
    });
  }

  async function applyDecision() {
    if (!open) return;
    const ok = await action.run(async () => {
      await api(
        `/complaints/${open.id}`,
        {
          status: decision.status,
          ...(decision.note.trim() ? { note: decision.note.trim() } : {}),
        },
        { method: "PATCH" },
      );
      return "Complaint updated.";
    });
    if (ok) {
      await Promise.all([loadInbox(), loadLocations()]);
      const refreshed = await api<{ complaint: Complaint; updates: Update[] }>(
        `/complaints/${open.id}`,
      );
      setOpen({ ...open, ...refreshed.complaint });
      setTrail(refreshed.updates);
      setDecision((d) => ({ ...d, note: "" }));
    }
  }

  return (
    <>
      <ErrorNote message={error} />
      {summary && (
        <div className="stats">
          {COMPLAINT_STATUSES.map((status) => (
            <div className="stat" key={status}>
              <span className="stat-value">{summary.byStatus[status] ?? 0}</span>
              <span className="stat-label">{COMPLAINT_STATUS_LABELS[status]}</span>
            </div>
          ))}
          <div className="stat">
            <span className="stat-value">{summary.activeLocations}</span>
            <span className="stat-label">Live reporting points</span>
          </div>
        </div>
      )}

      <div className="subtabs">
        {(
          [
            ["inbox", "Issues raised"],
            ["points", "Reporting points & QRs"],
          ] as Array<[typeof view, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={view === key ? "active" : "ghost"}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "inbox" && (
        <>
          <div className="grid-2">
            <Field label="Status">
              <select
                value={filter.status}
                onChange={(e) => {
                  setOffset(0);
                  setFilter({ ...filter, status: e.target.value });
                }}
              >
                <option value="">All statuses</option>
                {COMPLAINT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {COMPLAINT_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reporting point">
              <select
                value={filter.locationId}
                onChange={(e) => {
                  setOffset(0);
                  setFilter({ ...filter, locationId: e.target.value });
                }}
              >
                <option value="">All points</option>
                {(locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {!complaints ? (
            <Loading label="Loading issues…" />
          ) : complaints.items.length === 0 ? (
            <Empty>
              No issues reported here yet. Reports appear as soon as a participant scans a point.
            </Empty>
          ) : (
            <>
              <div className="scroll-x">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Reported</th>
                      <th>Point</th>
                      <th>Category</th>
                      <th>Issue</th>
                      <th>By</th>
                      <th>Status</th>
                      <th> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {complaints.items.map((item) => (
                      <tr key={item.id}>
                        <td className="meta">{formatWhen(item.createdAt)}</td>
                        <td>{item.locationLabel ?? "—"}</td>
                        <td>{COMPLAINT_CATEGORY_LABELS[item.category]}</td>
                        <td className="clip-2">{item.description}</td>
                        <td className="meta">{item.reporter.fullName}</td>
                        <td>
                          <span className={`badge ${STATUS_TONE[item.status]}`}>
                            {COMPLAINT_STATUS_LABELS[item.status]}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="ghost tiny"
                            onClick={() => void openComplaint(item)}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                offset={offset}
                limit={PAGE_SIZE}
                count={complaints.items.length}
                hasMore={complaints.hasMore}
                onChange={setOffset}
              />
            </>
          )}

          {open && (
            <div className="stack sub-form">
              <div className="row wrap">
                <h3>{open.locationLabel ?? "Issue"}</h3>
                <button type="button" className="ghost tiny" onClick={() => setOpen(null)}>
                  Close
                </button>
              </div>
              <p>{open.description}</p>
              <p className="meta">
                {COMPLAINT_CATEGORY_LABELS[open.category]} · reported by {open.reporter.fullName} (
                {open.reporter.email}) · {formatWhen(open.createdAt)}
              </p>
              {!trail ? (
                <Loading label="Loading history…" />
              ) : trail.length === 0 ? (
                <Empty>No handling notes yet.</Empty>
              ) : (
                <ul className="trail">
                  {trail.map((row) => (
                    <li key={row.update.id}>
                      <strong>
                        {row.update.toStatus
                          ? COMPLAINT_STATUS_LABELS[row.update.toStatus]
                          : "Updated"}
                      </strong>{" "}
                      <span className="meta">
                        {row.actor.fullName} · {formatWhen(row.update.createdAt)}
                      </span>
                      {row.update.note ? <p>{row.update.note}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid-2">
                <Field label="Move to">
                  <select
                    value={decision.status}
                    onChange={(e) =>
                      setDecision({ ...decision, status: e.target.value as ComplaintStatus })
                    }
                  >
                    {COMPLAINT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {COMPLAINT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Note for the record" hint="The student can see this on their report.">
                  <input
                    value={decision.note}
                    maxLength={2000}
                    onChange={(e) => setDecision({ ...decision, note: e.target.value })}
                  />
                </Field>
              </div>
              <div className="row">
                <button type="button" disabled={action.busy} onClick={() => void applyDecision()}>
                  Save update
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {view === "points" && (
        <>
          <p className="meta">
            Create a point for each place you want reports from, then download its poster. The
            poster carries this event and club, so students know who they are reporting to.
          </p>
          {!locations ? (
            <Loading label="Loading reporting points…" />
          ) : locations.length === 0 ? (
            <Empty>No reporting points yet.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Point</th>
                    <th>Where</th>
                    <th>Open</th>
                    <th>Total</th>
                    <th>State</th>
                    <th>QR poster</th>
                    {canManage && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {locations.map((l) => (
                    <tr key={l.id}>
                      <td>{l.label}</td>
                      <td className="meta">{l.description ?? "—"}</td>
                      <td>{l.open}</td>
                      <td>{l.total}</td>
                      <td>
                        <span className={`badge ${l.revokedAt ? "muted" : "good"}`}>
                          {l.revokedAt ? "Closed" : "Live"}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ghost tiny"
                          disabled={action.busy}
                          onClick={() => void download(l)}
                        >
                          Download PDF
                        </button>
                      </td>
                      {canManage && (
                        <td>
                          <div className="row">
                            <button
                              type="button"
                              className="ghost tiny"
                              onClick={() => {
                                setEditing(l);
                                setForm({ label: l.label, description: l.description ?? "" });
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="ghost tiny"
                              disabled={action.busy}
                              onClick={() =>
                                void action
                                  .run(async () => {
                                    await api(
                                      `/complaints/locations/${l.id}`,
                                      { revoked: !l.revokedAt },
                                      { method: "PATCH" },
                                    );
                                    return l.revokedAt ? "Point reopened." : "Point closed.";
                                  })
                                  .then(async (ok) => {
                                    if (ok) await Promise.all([loadLocations(), loadInbox()]);
                                  })
                              }
                            >
                              {l.revokedAt ? "Reopen" : "Close"}
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

          {canManage ? (
            <div className="stack sub-form">
              <h3>{editing ? `Edit ${editing.label}` : "Add a reporting point"}</h3>
              <div className="grid-2">
                <Field label="Point name" hint="What is printed on the poster, e.g. Food counter.">
                  <input
                    value={form.label}
                    maxLength={80}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                  />
                </Field>
                <Field label="Where exactly" hint="Optional directions printed under the name.">
                  <input
                    value={form.description}
                    maxLength={500}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </Field>
              </div>
              <div className="row">
                <button
                  type="button"
                  disabled={action.busy || form.label.trim().length < 2}
                  onClick={() => void saveLocation()}
                >
                  {editing ? "Save point" : "Add point"}
                </button>
                {editing && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setEditing(null);
                      setForm({ label: "", description: "" });
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="meta">
              Only this event&apos;s coordinators can add or close reporting points.
            </p>
          )}
          <p className="meta">
            Categories a student can pick:{" "}
            {COMPLAINT_CATEGORIES.map((c) => COMPLAINT_CATEGORY_LABELS[c]).join(", ")}.
          </p>
        </>
      )}
    </>
  );
}
