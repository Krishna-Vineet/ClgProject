import type { ReservationStatus } from "@campusops/shared/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApprovalBadge,
  Card,
  Empty,
  EventBadge,
  Field,
  ReservationBadge,
  formatWhen,
  useNotice,
} from "../components/ui";
import { type Page, api, errorMessage, getAccessToken } from "../lib/api";
import type { EventRow } from "../lib/types";

type ReportListItem = {
  id: string;
  sequence: number;
  eventRevision: number;
  generatedBy: { id: string; fullName: string };
  generatedAt: string;
  checksum: string;
  archivedFileId: string | null;
};

type Snapshot = {
  generatedAt: string;
  generatedBy: { fullName: string; email: string };
  institution: { timezone: string };
  event: {
    title: string;
    status: string;
    description: string;
    startsAt: string;
    endsAt: string;
    venueSummary: string | null;
    capacity: number;
    revision: number;
  };
  club: { name: string; department: string | null };
  organizers: Array<{ id: string; fullName: string; email: string; clubRole: string }>;
  clubFaculty: Array<{ fullName: string; email: string }>;
  facultyAdvisor?: { fullName: string; email: string } | null;
  approvals: Array<{
    requestId: string;
    title: string;
    type: string;
    isRequired: boolean;
    finalStatus: string;
    decidedBy: { fullName: string } | null;
    decidedAt: string | null;
    trail: Array<{
      action: string;
      actor: string;
      fromTier: string | null;
      toTier: string | null;
      comment: string | null;
      at: string;
    }>;
  }>;
  facultyInvolved: Array<{ id: string; fullName: string; email: string; role: string }>;
  resourcesUsed: Array<{
    resource: string;
    unit: string;
    code: string;
    startsAt: string;
    endsAt: string;
    status: ReservationStatus;
  }>;
  attendance: {
    registered: number;
    confirmed: number;
    waitlisted: number;
    cancelled: number;
    checkedIn: number;
    capacity: number;
    fillRatePercent: number | null;
    attendanceRatePercent: number | null;
    source: "QR_SCAN" | "REGISTRATION_ONLY";
  };
  attendeesTruncated: boolean;
  attendees: Array<{
    userId: string;
    fullName: string;
    email: string;
    rollNumber: string | null;
    department: string | null;
    registrationStatus: string;
    checkedInAt: string | null;
  }>;
  notes: string | null;
  /** Present on a filed report; a preview computes the same value beside it. */
  integrity?: { algorithm: string; checksum: string } | undefined;
};

/** The checksum a snapshot carries, whether filed or previewed. */
function checksumOf(snapshot: Snapshot | null): string | null {
  return snapshot?.integrity?.checksum ?? null;
}

/**
 * Post-event reports. Anyone with institutional access (coordinators, involved
 * faculty, department HOD/Dean, Admin) can open this; the API decides which
 * events appear, so an unrelated club never shows up here.
 */
export function ReportsPanel() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventId, setEventId] = useState("");
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Every panel message is a toast: it appears where the eye is, including
  // over an open dialog, instead of in a bar at the top of the card.
  useNotice(error, notice);
  const [busy, setBusy] = useState(false);
  // Guards against out-of-order responses: opening an older version must never
  // overwrite a snapshot the user has just generated.
  const loadSeq = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const page = await api<Page<EventRow>>("/me/events?limit=100");
        // Only finished or cancelled events can be reported on.
        setEvents(page.items.filter((e) => e.status === "COMPLETED" || e.status === "CANCELLED"));
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoadingEvents(false);
      }
    })();
  }, []);

  const loadReports = useCallback(async (id: string) => {
    const page = await api<{ items: ReportListItem[] }>(`/events/${id}/reports`);
    setReports(page.items);
    return page.items;
  }, []);

  async function chooseEvent(id: string) {
    loadSeq.current += 1;
    setEventId(id);
    setSnapshot(null);
    setReports([]);
    setError(null);
    setNotice(null);
    if (!id) return;
    try {
      const items = await loadReports(id);
      if (items[0]) await openReport(items[0].id, id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openReport(reportId: string, forEventId = eventId) {
    if (!forEventId) return;
    const seq = ++loadSeq.current;
    setError(null);
    try {
      const result = await api<{ snapshot: Snapshot; integrity: { verified: boolean } }>(
        `/events/${forEventId}/reports/${reportId}`,
      );
      if (seq !== loadSeq.current) return; // a newer action already won
      setSnapshot(result.snapshot);
      if (!result.integrity.verified)
        setError("This filed report failed its integrity check. Do not rely on it.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function preview() {
    const seq = ++loadSeq.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ snapshot: Snapshot; checksum?: string }>(
        `/events/${eventId}/report-preview`,
      );
      if (seq !== loadSeq.current) return;
      // Normalise: an older server sent the checksum beside the snapshot rather
      // than inside it. Fold both shapes into one so the render below has a
      // single source of truth.
      setSnapshot(
        result.snapshot.integrity || !result.checksum
          ? result.snapshot
          : { ...result.snapshot, integrity: { algorithm: "sha256", checksum: result.checksum } },
      );
      setNotice("Preview only — nothing has been filed yet.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    const seq = ++loadSeq.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{
        report: { id: string; sequence: number };
        snapshot: Snapshot;
        archived: boolean;
        archiveNote?: string;
      }>(`/events/${eventId}/reports`, notes.trim() ? { notes: notes.trim() } : {});
      if (seq !== loadSeq.current) return;
      setSnapshot(result.snapshot);
      setNotes("");
      await loadReports(eventId);
      setNotice(
        result.archived
          ? `Report #${result.report.sequence} filed and archived.`
          : `Report #${result.report.sequence} filed. ${result.archiveNote ?? ""}`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The PDF endpoint needs the bearer token, so fetch it as a blob rather than
   * linking directly — a plain <a href> would arrive unauthenticated.
   */
  async function download(reportId: string) {
    if (!eventId) return;
    setError(null);
    try {
      const res = await fetch(`/api/v1/events/${eventId}/reports/${reportId}/pdf`, {
        headers: { authorization: `Bearer ${getAccessToken() ?? ""}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `event-report-${reportId.slice(0, 8)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const chosen = events.find((e) => e.id === eventId);

  return (
    <div className="stack">
      <Card title="Event reports">
        <p className="muted">
          A filed record of who authorised the event, which club and coordinators ran it, which
          faculty were involved, the resources used, and who attended. Reports are immutable —
          generating again creates a new numbered version.
        </p>
        <Field label="Finished event">
          <select
            value={eventId}
            disabled={loadingEvents}
            onChange={(e) => chooseEvent(e.target.value)}
          >
            <option value="">{loadingEvents ? "Loading events…" : "Choose an event…"}</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </Field>
        {!loadingEvents && events.length === 0 && (
          <Empty>No completed or cancelled events yet. Reports open once an event has ended.</Empty>
        )}
        {chosen && (
          <div className="row" style={{ gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <EventBadge status={chosen.status} />
            <span className="muted">
              {formatWhen(chosen.startsAt)} · {chosen.venueSummary ?? "venue not recorded"}
            </span>
          </div>
        )}
      </Card>

      {eventId && (
        <Card title="Generate a report">
          <Field label="Coordinator notes (optional)">
            <textarea
              rows={3}
              value={notes}
              maxLength={4000}
              placeholder="Anything worth recording: overruns, equipment issues, changes on the day."
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button type="button" className="ghost" disabled={busy} onClick={preview}>
              Preview without filing
            </button>
            <button type="button" disabled={busy} onClick={generate}>
              {busy ? "Working…" : "Generate report"}
            </button>
          </div>
        </Card>
      )}

      {reports.length > 0 && (
        <Card title="Filed versions">
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Generated</th>
                  <th>By</th>
                  <th>Archive</th>
                  <th> </th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td>#{r.sequence}</td>
                    <td>{formatWhen(r.generatedAt)}</td>
                    <td>{r.generatedBy.fullName}</td>
                    <td className="muted">
                      {r.archivedFileId ? "Stored" : "Re-rendered on demand"}
                    </td>
                    <td>
                      <div className="row" style={{ gap: "0.35rem" }}>
                        <button type="button" className="ghost" onClick={() => openReport(r.id)}>
                          View
                        </button>
                        <button type="button" onClick={() => download(r.id)}>
                          PDF
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {snapshot?.event && (
        <>
          <Card title="Event summary">
            <dl className="kv">
              <dt>Event</dt>
              <dd>{snapshot.event.title}</dd>
              <dt>Club</dt>
              <dd>
                {snapshot.club.name}
                {snapshot.club.department ? ` · ${snapshot.club.department}` : ""}
              </dd>
              <dt>When</dt>
              <dd>
                {formatWhen(snapshot.event.startsAt)} → {formatWhen(snapshot.event.endsAt)}
              </dd>
              <dt>Venue</dt>
              <dd>{snapshot.event.venueSummary ?? "Not recorded"}</dd>
              <dt>Generated</dt>
              <dd>
                {formatWhen(snapshot.generatedAt)} by {snapshot.generatedBy.fullName}
              </dd>
            </dl>
            <p>{snapshot.event.description || "No description recorded."}</p>
          </Card>

          <Card title="Organised by">
            <div className="scroll-x">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Email</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.organizers.map((o) => (
                    <tr key={o.id}>
                      <td>{o.fullName}</td>
                      <td>{o.clubRole === "LEAD" ? "Club lead" : "Coordinator"}</td>
                      <td className="muted">{o.email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {snapshot.clubFaculty?.length ? (
              <p className="meta">
                Club faculty:{" "}
                {snapshot.clubFaculty.map((f) => `${f.fullName} (${f.email})`).join("; ")}
              </p>
            ) : null}
            {!snapshot.clubFaculty?.length && snapshot.facultyAdvisor && (
              <p className="muted">
                Faculty advisor: {snapshot.facultyAdvisor.fullName} ({snapshot.facultyAdvisor.email}
                )
              </p>
            )}
          </Card>

          <Card title="Permissions and approvals">
            {snapshot.approvals.length === 0 && <Empty>No approval requests recorded.</Empty>}
            {snapshot.approvals.map((a) => (
              <div key={a.requestId} className="approval-block">
                <div
                  className="row"
                  style={{ gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
                >
                  <strong>{a.title}</strong>
                  <ApprovalBadge status={a.finalStatus as never} />
                  <span className="muted">{a.isRequired ? "Required" : "Optional"}</span>
                </div>
                {a.decidedBy && (
                  <p className="muted">
                    Decided by {a.decidedBy.fullName} on {formatWhen(a.decidedAt)}
                  </p>
                )}
                <ol className="trail">
                  {a.trail.map((t) => (
                    <li key={`${a.requestId}-${t.at}-${t.action}`}>
                      <strong>{t.action}</strong> by {t.actor}
                      {t.toTier ? ` → ${t.toTier.replace(/_/g, "/")}` : ""} · {formatWhen(t.at)}
                      {t.comment ? <div className="muted">“{t.comment}”</div> : null}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </Card>

          <Card title="Faculty involved">
            {snapshot.facultyInvolved.length === 0 ? (
              <Empty>No faculty involvement recorded.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Involvement</th>
                      <th>Email</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.facultyInvolved.map((f) => (
                      <tr key={f.id}>
                        <td>{f.fullName}</td>
                        <td>{f.role}</td>
                        <td className="muted">{f.email}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Resources used">
            {snapshot.resourcesUsed.length === 0 ? (
              <Empty>No resources booked.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Resource</th>
                      <th>Unit</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.resourcesUsed.map((r) => (
                      <tr key={`${r.code}-${r.startsAt}`}>
                        <td>{r.resource}</td>
                        <td>
                          {r.unit} <span className="muted">[{r.code}]</span>
                        </td>
                        <td>{formatWhen(r.startsAt)}</td>
                        <td>{formatWhen(r.endsAt)}</td>
                        <td>
                          <ReservationBadge status={r.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Attendance">
            <div className="stats">
              <div>
                <span className="stat-value">{snapshot.attendance.registered}</span>
                <span className="stat-label">Registered</span>
              </div>
              <div>
                <span className="stat-value">{snapshot.attendance.confirmed}</span>
                <span className="stat-label">Confirmed</span>
              </div>
              <div>
                <span className="stat-value">{snapshot.attendance.waitlisted}</span>
                <span className="stat-label">Waitlisted</span>
              </div>
              <div>
                <span className="stat-value">{snapshot.attendance.capacity}</span>
                <span className="stat-label">Capacity</span>
              </div>
              {snapshot.attendance.source === "QR_SCAN" && (
                <div>
                  <span className="stat-value">{snapshot.attendance.checkedIn}</span>
                  <span className="stat-label">Checked in</span>
                </div>
              )}
            </div>
            {snapshot.attendance.source === "REGISTRATION_ONLY" && (
              <p className="muted">
                Check-in was not recorded with QR scanning, so these are confirmed registrations
                only. No claim is made about physical presence.
              </p>
            )}
            {snapshot.attendeesTruncated && (
              <p className="muted">
                Showing the first {snapshot.attendees.length} of {snapshot.attendance.registered}{" "}
                registrations. The totals above are exact; only this list is capped.
              </p>
            )}
            {snapshot.attendees.length === 0 ? (
              <Empty>No registrations recorded.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>Roll no.</th>
                      <th>Department</th>
                      <th>Status</th>
                      <th>Check-in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.attendees.map((a, i) => (
                      <tr key={a.userId}>
                        <td>{i + 1}</td>
                        <td>{a.fullName}</td>
                        <td>{a.rollNumber ?? "—"}</td>
                        <td>{a.department ?? "—"}</td>
                        <td>{a.registrationStatus}</td>
                        <td>{a.checkedInAt ? formatWhen(a.checkedInAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {snapshot.notes && (
            <Card title="Coordinator notes">
              <p>{snapshot.notes}</p>
            </Card>
          )}

          <Card title="Record integrity">
            <p className="muted">
              {snapshot.integrity ? "SHA-256 of the filed snapshot" : "SHA-256 of this preview"}
            </p>
            {/* Optional by construction: a preview is rendered before anything is
                filed. Reading straight through `snapshot.integrity.checksum`
                crashed the whole panel when it was absent — a preview should
                degrade to "not yet filed", never to a blank screen. */}
            <code className="checksum">{checksumOf(snapshot) ?? "Not available"}</code>
          </Card>
        </>
      )}
    </div>
  );
}
