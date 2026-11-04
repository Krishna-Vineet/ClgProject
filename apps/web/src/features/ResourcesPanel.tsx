import { RESOURCE_STATUS_LABELS, type ResourceStatus } from "@campusops/shared/ui";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ConfirmDialog,
  FormDialog,
  Modal,
  Pager,
  useAction,
  useToast,
} from "../components/feedback";
import { Card, Empty, Field, ReservationBadge, formatWhen, toLocalInput } from "../components/ui";
import { type Page, api, errorMessage, query } from "../lib/api";
import { PAGE_SIZE } from "../lib/constants";
import { useSession } from "../lib/session";

type Unit = {
  id: string;
  label: string;
  status: ResourceStatus;
  notes: string | null;
};
type ResourceRow = {
  id: string;
  name: string;
  status: ResourceStatus;
  capacity: number | null;
  departmentId: string | null;
  description: string | null;
  units: Unit[];
  canManage: boolean;
};
type Booking = {
  reservationId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  eventId: string | null;
  eventStatus: string | null;
  clubName: string | null;
  title: string;
};
type CalendarRow = {
  resourceUnitId: string;
  unitLabel: string;
  unitStatus: ResourceStatus;
  resourceName: string;
  resourceStatus: ResourceStatus;
  capacity: number | null;
  bookings: Booking[];
};
type Department = { id: string; name: string };

type Sub = "calendar" | "catalogue";

const WEEK_LENGTH = 6;

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWeek(date: Date) {
  const d = startOfDay(date);
  const offset = (d.getDay() + 6) % 7;
  return addDays(d, -offset);
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function durationMinutes(booking: Booking) {
  return Math.max(
    1,
    Math.round(
      (new Date(booking.endsAt).getTime() - new Date(booking.startsAt).getTime()) / 60_000,
    ),
  );
}

function durationLabel(minutes: number) {
  if (minutes >= 1_440) {
    const days = Math.round(minutes / 1_440);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours} hr${rest ? ` ${rest} min` : ""}`;
  }
  return `${minutes} min`;
}

function dayPortion(booking: Booking, day: Date) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const startsAt = new Date(booking.startsAt);
  const endsAt = new Date(booking.endsAt);
  if (endsAt <= dayStart || startsAt >= dayEnd) return null;
  return {
    from: startsAt < dayStart ? dayStart : startsAt,
    to: endsAt > dayEnd ? dayEnd : endsAt,
  };
}

function plainStatus(value: string) {
  return value.replace(/_/g, " ").toLowerCase();
}

function startOfDay(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateInput(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fromDateInput(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function ResourcesPanel() {
  const { isAdmin, isSenior } = useSession();
  const [sub, setSub] = useState<Sub>("calendar");
  const mayManage = isAdmin || isSenior;

  return (
    <div className="stack">
      <div className="subtabs">
        {(
          [
            ["calendar", "Calendar"],
            ["catalogue", "Catalogue and units"],
          ] as Array<[Sub, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={sub === id ? "active" : "ghost"}
            onClick={() => setSub(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === "calendar" && <CalendarView />}
      {sub === "catalogue" && <Catalogue mayManage={mayManage} />}
    </div>
  );
}

function CalendarView() {
  const toast = useToast();
  const [rows, setRows] = useState<CalendarRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState("");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ row: CalendarRow; booking: Booking } | null>(null);
  const [tip, setTip] = useState<{
    row: CalendarRow;
    booking: Booking;
    left: number;
    top: number;
  } | null>(null);

  useEffect(() => {
    api<{ items: Department[] }>("/departments")
      .then((d) => setDepartments(d.items))
      .catch(() => {});
  }, []);

  const days = useMemo(
    () => Array.from({ length: WEEK_LENGTH }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekEnd = days[days.length - 1] ?? weekStart;
  // The API window is half-open, so it must run to the following midnight.
  const windowEnd = useMemo(() => addDays(weekStart, WEEK_LENGTH), [weekStart]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ rows: CalendarRow[] }>(
        `/resources/calendar${query({
          startsAt: weekStart.toISOString(),
          endsAt: windowEnd.toISOString(),
          ...(departmentId ? { departmentId } : {}),
        })}`,
      );
      setRows(res.rows);
    } catch (err) {
      toast.err(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [weekStart, windowEnd, departmentId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const hideTip = () => setTip(null);
    window.addEventListener("scroll", hideTip, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", hideTip, { capture: true });
  }, []);

  function shiftWeek(delta: number) {
    setTip(null);
    setWeekStart((current) => addDays(current, delta * 7));
  }

  function showTip(
    event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>,
    row: CalendarRow,
    booking: Booking,
  ) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 304;
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const below = rect.bottom + 10;
    const top = below + 210 > window.innerHeight ? Math.max(12, rect.top - 218) : below;
    setTip({ row, booking, left, top });
  }

  const today = new Date();

  return (
    <>
      <Card
        title="Resource calendar"
        actions={
          <div className="row">
            <button type="button" className="ghost tiny" onClick={() => shiftWeek(-1)}>
              ← Previous
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={() => {
                setTip(null);
                setWeekStart(startOfWeek(new Date()));
              }}
            >
              This week
            </button>
            <button type="button" className="ghost tiny" onClick={() => shiftWeek(1)}>
              Next →
            </button>
          </div>
        }
      >
        <p className="meta">
          One week of every booked room, lab and piece of equipment. Monday to Saturday, with the
          header and resource column pinned while you scroll. Click a booking for the full record.
        </p>
        <p className="timeline-range">
          <strong>
            {weekStart.toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </strong>
          <span aria-hidden="true">→</span>
          <strong>
            {weekEnd.toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </strong>
        </p>
        <div className="toolbar">
          <Field label="Week of (Monday)">
            <input
              type="date"
              value={toDateInput(weekStart)}
              onChange={(e) => {
                if (e.target.value) {
                  setTip(null);
                  setWeekStart(startOfWeek(fromDateInput(e.target.value)));
                }
              }}
            />
          </Field>
          <Field label="Department">
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>

        <div className="timeline-legend">
          <span>
            <i className="timeline-dot requested" /> Requested
          </span>
          <span>
            <i className="timeline-dot approved" /> Approved
          </span>
          <span>
            <i className="timeline-dot confirmed" /> Confirmed
          </span>
        </div>

        {loading ? (
          <p className="meta">Loading the calendar…</p>
        ) : rows.length === 0 ? (
          <Empty>No resource units match this view.</Empty>
        ) : (
          <div
            className="week-scroll"
            onScroll={() => setTip(null)}
            aria-label={`Resource bookings for the week of ${toDateInput(weekStart)}`}
          >
            <div className="week-grid">
              <div className="week-corner">Resource / unit</div>
              {days.map((day) => {
                const isToday = sameDay(day, today);
                return (
                  <div
                    key={toDateInput(day)}
                    className={`week-day-head${isToday ? " is-today" : ""}`}
                  >
                    <span>{day.toLocaleDateString(undefined, { weekday: "long" })}</span>
                    <strong>{day.getDate()}</strong>
                    <small>{day.toLocaleDateString(undefined, { month: "short" })}</small>
                  </div>
                );
              })}
              {rows.map((row) => (
                <Fragment key={row.resourceUnitId}>
                  <div className="week-resource">
                    <strong>{row.resourceName}</strong>
                    <span className="meta">{row.unitLabel}</span>
                    <span className={`week-unit-state ${row.unitStatus.toLowerCase()}`}>
                      {RESOURCE_STATUS_LABELS[row.unitStatus]}
                    </span>
                  </div>
                  {days.map((day) => {
                    const forDay = row.bookings
                      .map((booking) => ({ booking, portion: dayPortion(booking, day) }))
                      .filter(
                        (entry): entry is { booking: Booking; portion: { from: Date; to: Date } } =>
                          entry.portion !== null,
                      );
                    return (
                      <div
                        key={`${row.resourceUnitId}-${toDateInput(day)}`}
                        className={`week-cell${sameDay(day, today) ? " is-today" : ""}`}
                      >
                        {forDay.length === 0 ? (
                          <span className="week-free">Free</span>
                        ) : (
                          forDay.map(({ booking, portion }) => (
                            <button
                              key={booking.reservationId}
                              type="button"
                              className={`week-booking ${booking.status.toLowerCase()}`}
                              onMouseEnter={(event) => showTip(event, row, booking)}
                              onFocus={(event) => showTip(event, row, booking)}
                              onMouseLeave={() => setTip(null)}
                              onBlur={() => setTip(null)}
                              onClick={() => {
                                setTip(null);
                                setDetail({ row, booking });
                              }}
                            >
                              <span className="wb-time">
                                {portion.from.toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                                –
                                {portion.to.toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                              <span className="wb-title">
                                {booking.eventId ? booking.title : "Reserved"}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        )}
      </Card>

      {tip && (
        <div
          className="booking-tip"
          style={{ left: `${tip.left}px`, top: `${tip.top}px` }}
          role="tooltip"
        >
          <div className="bt-top">
            <strong>{tip.booking.eventId ? tip.booking.title : "Reserved by another club"}</strong>
            <ReservationBadge status={tip.booking.status as never} />
          </div>
          <p className="bt-place">
            {tip.row.resourceName} · {tip.row.unitLabel}
          </p>
          <dl className="bt-kv">
            <dt>When</dt>
            <dd>
              {formatWhen(tip.booking.startsAt)} → {formatWhen(tip.booking.endsAt)}
            </dd>
            <dt>Length</dt>
            <dd>{durationLabel(durationMinutes(tip.booking))}</dd>
            <dt>Club</dt>
            <dd>{tip.booking.clubName ?? "Another club"}</dd>
            {tip.booking.eventStatus && (
              <>
                <dt>Event</dt>
                <dd>{plainStatus(tip.booking.eventStatus)}</dd>
              </>
            )}
          </dl>
          <span className="bt-hint">Click for the full record</span>
        </div>
      )}

      <Modal
        open={detail !== null}
        title={detail?.booking.eventId ? detail.booking.title : "Reserved booking"}
        description={detail ? `${detail.row.resourceName} · ${detail.row.unitLabel}` : undefined}
        onClose={() => setDetail(null)}
        footer={
          <button type="button" className="ghost" onClick={() => setDetail(null)}>
            Close
          </button>
        }
      >
        {detail && (
          <div className="stack">
            <div className="booking-detail-top">
              <ReservationBadge status={detail.booking.status as never} />
              <span className="badge">{durationLabel(durationMinutes(detail.booking))}</span>
              <span className="badge">{detail.row.unitLabel}</span>
            </div>
            <dl className="kv">
              <dt>Starts</dt>
              <dd>{formatWhen(detail.booking.startsAt)}</dd>
              <dt>Ends</dt>
              <dd>{formatWhen(detail.booking.endsAt)}</dd>
              <dt>Length</dt>
              <dd>{durationLabel(durationMinutes(detail.booking))}</dd>
              <dt>Resource</dt>
              <dd>
                {detail.row.resourceName}
                {detail.row.capacity !== null ? ` · seats ${detail.row.capacity}` : ""}
              </dd>
              <dt>Resource state</dt>
              <dd>
                {RESOURCE_STATUS_LABELS[detail.row.resourceStatus]} · unit{" "}
                {RESOURCE_STATUS_LABELS[detail.row.unitStatus].toLowerCase()}
              </dd>
              <dt>Club</dt>
              <dd>{detail.booking.clubName ?? "Another club"}</dd>
              <dt>Event</dt>
              <dd>
                {detail.booking.eventId
                  ? `${detail.booking.title} · ${plainStatus(detail.booking.eventStatus ?? "")}`
                  : "Details withheld"}
              </dd>
            </dl>
            {detail.booking.eventId ? (
              <p className="meta">
                This hold belongs to an event. Open it from Events to change or release the booking
                — reservations are only edited through the event that owns them.
              </p>
            ) : (
              <p className="meta">
                This hold belongs to another club that you do not oversee, so the event details stay
                private. The time and unit are still blocked.
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

function Catalogue({ mayManage }: { mayManage: boolean }) {
  const { isAdmin, scopedDepartmentIds } = useSession();
  const scopedOnly = mayManage && !isAdmin;
  const toast = useToast();
  const action = useAction();
  const [rows, setRows] = useState<ResourceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    capacity: "",
    departmentId: scopedOnly ? (scopedDepartmentIds[0] ?? "") : "",
    description: "",
    unitLabels: "",
  });
  const [selected, setSelected] = useState<ResourceRow | null>(null);
  const [unitForm, setUnitForm] = useState({ label: "", notes: "" });
  const [retire, setRetire] = useState<Unit | null>(null);
  const [unitOpen, setUnitOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api<Page<ResourceRow>>(
        `/resources${query({ q, limit: PAGE_SIZE, offset })}`,
      );
      setRows(page.items);
      setTotal(page.total ?? page.items.length);
    } catch (err) {
      toast.err(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [q, offset, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<{ items: Department[] }>("/departments")
      .then((d) => setDepartments(d.items))
      .catch(() => {});
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      await api("/resources", {
        name: form.name,
        ...(form.capacity ? { capacity: Number(form.capacity) } : {}),
        ...(form.departmentId ? { departmentId: form.departmentId } : {}),
        ...(form.description ? { description: form.description } : {}),
        unitLabels: form.unitLabels
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setCreating(false);
      setForm({
        name: "",
        capacity: "",
        departmentId: scopedOnly ? (scopedDepartmentIds[0] ?? "") : "",
        description: "",
        unitLabels: "",
      });
      await load();
      return "Resource created.";
    });
  }

  async function openResource(r: ResourceRow) {
    await action.run(async () => {
      const full = await api<ResourceRow>(`/resources/${r.id}`);
      setSelected({ ...full, canManage: r.canManage });
      setUnitForm({ label: "", notes: "" });
    });
  }

  async function addUnit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    await action.run(async () => {
      await api(`/resources/${selected.id}/units`, {
        label: unitForm.label,
        ...(unitForm.notes ? { notes: unitForm.notes } : {}),
      });
      const full = await api<ResourceRow>(`/resources/${selected.id}`);
      setSelected({ ...full, canManage: selected.canManage });
      setUnitForm({ label: "", notes: "" });
      setUnitOpen(false);
      await load();
      return "Unit added.";
    });
  }

  async function setResourceStatus(status: ResourceStatus) {
    if (!selected) return;
    await action.run(async () => {
      await api(`/resources/${selected.id}`, { status }, { method: "PATCH" });
      const full = await api<ResourceRow>(`/resources/${selected.id}`);
      setSelected({ ...full, canManage: selected.canManage });
      await load();
      return `Resource marked ${status.toLowerCase()}.`;
    });
  }

  async function doRetire() {
    if (!selected || !retire) return;
    await action.run(async () => {
      await api(`/resource-units/${retire.id}`, { status: "RETIRED" }, { method: "PATCH" });
      const full = await api<ResourceRow>(`/resources/${selected.id}`);
      setSelected({ ...full, canManage: selected.canManage });
      setRetire(null);
      await load();
      return "Unit retired.";
    });
  }

  const deptName = (id: string | null) =>
    id ? (departments.find((d) => d.id === id)?.name ?? "—") : "Institution-wide";

  return (
    <>
      <Card
        title="Catalogue and units"
        actions={
          mayManage ? (
            <button type="button" onClick={() => setCreating(true)}>
              Add resource
            </button>
          ) : undefined
        }
      >
        {!mayManage && (
          <p className="meta">
            Only Admin and HOD/Dean can change the inventory. You can browse it and check
            availability.
          </p>
        )}

        <div className="toolbar">
          <Field label="Search">
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <button type="button" className="ghost" onClick={() => void load()}>
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="meta">Loading…</p>
        ) : rows.length === 0 ? (
          <Empty>No resources match this filter.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Department</th>
                  <th>Units</th>
                  <th>Status</th>
                  <th> </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className="meta">{deptName(r.departmentId)}</td>
                    <td>{r.units.length}</td>
                    <td>
                      <span className="chip">{RESOURCE_STATUS_LABELS[r.status]}</span>
                    </td>
                    <td>
                      <button type="button" className="ghost tiny" onClick={() => openResource(r)}>
                        Open
                      </button>
                    </td>
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
          total={total}
          onChange={setOffset}
        />
      </Card>

      <FormDialog
        open={creating}
        title="Add a resource"
        description="Bookings attach to a unit, not the resource, so two projectors of the same model can be booked independently."
        submitLabel="Create resource"
        size="lg"
        busy={action.busy}
        onClose={() => setCreating(false)}
        onSubmit={create}
      >
        <div className="grid-2">
          <Field label="Name">
            <input
              required
              minLength={2}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Capacity (optional)">
            <input
              type="number"
              min={1}
              value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            />
          </Field>
          <Field
            label="Owning department"
            hint={
              scopedOnly
                ? "Resources you add must belong to a department you head."
                : "Leave institution-wide for shared inventory."
            }
          >
            <select
              required={scopedOnly}
              value={form.departmentId}
              onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
            >
              {!scopedOnly && <option value="">Institution-wide</option>}
              {departments
                .filter((d) => !scopedOnly || scopedDepartmentIds.includes(d.id))
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <Field label="Bookable units (one per line)">
          <textarea
            rows={3}
            placeholder={"Lab 2 Room\nProjector 01"}
            value={form.unitLabels}
            onChange={(e) => setForm({ ...form, unitLabels: e.target.value })}
          />
        </Field>
      </FormDialog>

      <Modal
        open={selected !== null}
        size="lg"
        title={selected?.name ?? "Resource"}
        description={selected ? deptName(selected.departmentId) : undefined}
        onClose={() => setSelected(null)}
        footer={
          <>
            {selected?.canManage && (
              <button type="button" className="ghost" onClick={() => setUnitOpen(true)}>
                Add unit
              </button>
            )}
            {selected?.canManage && selected.status !== "RETIRED" && (
              <button
                type="button"
                className="ghost"
                disabled={action.busy}
                onClick={() => void setResourceStatus("RETIRED")}
              >
                Retire resource
              </button>
            )}
            <button type="button" className="ghost" onClick={() => setSelected(null)}>
              Close
            </button>
          </>
        }
      >
        {selected && (
          <div className="stack">
            <dl className="kv">
              <dt>Capacity</dt>
              <dd>{selected.capacity ?? "—"}</dd>
              <dt>Status</dt>
              <dd>{RESOURCE_STATUS_LABELS[selected.status]}</dd>
              <dt>Department</dt>
              <dd>{deptName(selected.departmentId)}</dd>
              <dt>Description</dt>
              <dd>{selected.description || "—"}</dd>
            </dl>

            <h3>Units</h3>
            {selected.units.length === 0 ? (
              <Empty>No units. Add at least one so this resource can be booked.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th>Status</th>
                      <th>Notes</th>
                      {selected.canManage && <th> </th>}
                    </tr>
                  </thead>
                  <tbody>
                    {selected.units.map((u) => (
                      <tr key={u.id}>
                        <td>{u.label}</td>
                        <td>
                          <span className="chip">{RESOURCE_STATUS_LABELS[u.status]}</span>
                        </td>
                        <td className="meta">{u.notes ?? "—"}</td>
                        {selected.canManage && (
                          <td>
                            {u.status !== "RETIRED" && (
                              <button
                                type="button"
                                className="ghost tiny"
                                onClick={() => setRetire(u)}
                              >
                                Retire
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
          </div>
        )}
      </Modal>

      <FormDialog
        open={unitOpen}
        title="Add a bookable unit"
        description="Each unit is booked independently and appears in the availability calendar."
        submitLabel="Add unit"
        busy={action.busy}
        onClose={() => setUnitOpen(false)}
        onSubmit={addUnit}
      >
        <div className="grid-2">
          <Field label="Label">
            <input
              required
              value={unitForm.label}
              onChange={(e) => setUnitForm({ ...unitForm, label: e.target.value })}
            />
          </Field>
          <Field label="Notes">
            <input
              value={unitForm.notes}
              onChange={(e) => setUnitForm({ ...unitForm, notes: e.target.value })}
            />
          </Field>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={retire !== null}
        title={`Retire ${retire?.label ?? ""}?`}
        description="A unit with an active or confirmed booking cannot be retired. Past bookings and reports keep their history."
        confirmLabel="Retire unit"
        busy={action.busy}
        onCancel={() => setRetire(null)}
        onConfirm={doRetire}
      />
    </>
  );
}
