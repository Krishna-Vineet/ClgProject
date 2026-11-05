import type { EventStatus } from "@campusops/shared/ui";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/icons";
import { CAMPUS_TIME_ZONE, Card, Empty, EventBadge, Skeleton, formatWhen } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";

export type DashboardData = {
  generatedAt: string;
  scope: "INSTITUTION" | "DEPARTMENT" | "CLUBS" | "PERSONAL";
  events: {
    total: number;
    live: number;
    upcoming: number;
    draft: number;
    pendingApprovals: number;
    completed: number;
  };
  registrations: { confirmed: number; waitlisted: number; applied: number };
  work: {
    approvalsPending: number;
    verificationPending: number;
    openComplaints: number;
    resourceHolds: number;
  };
  upcoming: Array<{
    id: string;
    title: string;
    status: EventStatus;
    startsAt: string;
    endsAt: string;
    venueSummary: string | null;
    capacity: number;
    clubName: string;
    confirmed: number;
  }>;
  confirmationTrend: Array<{ day: string; confirmed: number }>;
  approvalQueue: Array<{
    request: { id: string; title: string; dueAt: string | null };
    event: { id: string; title: string; startsAt: string };
    club: { name: string };
  }>;
};

const SCOPE_LABEL: Record<DashboardData["scope"], string> = {
  INSTITUTION: "Institution-wide",
  DEPARTMENT: "Your departments",
  CLUBS: "Your clubs",
  PERSONAL: "Your workload",
};

const SCOPE_NOTE: Record<DashboardData["scope"], string> = {
  INSTITUTION: "Everything below is scoped to the whole institution.",
  DEPARTMENT: "Everything below is scoped to the departments you oversee.",
  CLUBS: "Everything below is scoped to your clubs and their events.",
  PERSONAL: "Everything below is scoped to your own workload.",
};

export const DashboardPanel = memo(function DashboardPanel({
  onNavigate,
  onOpenEvent,
}: { onNavigate: (tab: string) => void; onOpenEvent: (id: string) => void }) {
  const { me, isCoordinator, isClubMember, isStaff, isFaculty, isSenior } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async (quiet = false) => {
    setError(null);
    if (!quiet) setRefreshing(true);
    try {
      setData(await api<DashboardData>("/me/dashboard"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
      setTick((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const t = setInterval(() => void load(true), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const now = Date.now();
  const hour = new Date(now).getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = me?.user.fullName ?? "there";

  const nextEvent = useMemo(() => {
    if (!data?.upcoming.length) return null;
    const live = data.upcoming.find((e) => e.status === "LIVE");
    if (live) return live;
    return [...data.upcoming].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    )[0];
  }, [data]);

  if (loading) return <DashboardSkeleton />;
  if (error)
    return (
      <Card
        title="The dashboard did not load"
        subtitle="The rest of the console is still available."
      >
        <p className="bad-note" role="alert">
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </p>
        <div className="row">
          <button type="button" onClick={() => void load()}>
            <Icon name="refresh" size={14} /> Try again
          </button>
        </div>
      </Card>
    );
  if (!data) return null;

  const total =
    data.registrations.confirmed + data.registrations.waitlisted + data.registrations.applied;
  const confirmedShare = total ? Math.round((data.registrations.confirmed / total) * 100) : 0;
  const attention =
    data.work.approvalsPending + data.work.verificationPending + data.work.openComplaints;

  const workItems = [
    isStaff && {
      icon: "inbox",
      tone: "tone-brand",
      label: "Approvals waiting on you",
      sub: "Approve, ask for a change, or escalate",
      n: data.work.approvalsPending,
      tab: "approvals",
    },
    (isFaculty || isSenior) && {
      icon: "shield",
      tone: "tone-mint",
      label: "Students to verify",
      sub: "College ID checks in your scope",
      n: data.work.verificationPending,
      tab: "verification",
    },
    (isClubMember || isStaff) && {
      icon: "alert",
      tone: "tone-peach",
      label: "Open participant issues",
      sub: "Only events you organise or oversee",
      n: data.work.openComplaints,
      tab: "events",
    },
    {
      icon: "box",
      tone: "tone-sky",
      label: "Resource holds",
      sub: "Waiting on an approval decision",
      n: data.work.resourceHolds,
      tab: "resources",
    },
  ].filter(Boolean) as Array<{
    icon: string;
    tone: string;
    label: string;
    sub: string;
    n: number;
    tab: string;
  }>;

  return (
    <>
      <div className="dash-head">
        <div>
          <p className="eyebrow">
            {SCOPE_LABEL[data.scope]} ·{" "}
            {new Date().toLocaleDateString("en-IN", {
              timeZone: CAMPUS_TIME_ZONE,
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
          <h1>
            {greeting}, {firstName}.
          </h1>
          <p className="lead">
            {attention > 0
              ? `${attention} thing${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} a decision from you. Everything else is moving.`
              : "Nothing is waiting on you. The desk is clear and the calendar is under control."}
          </p>
        </div>
        <div className="page-head-actions">
          {isCoordinator && (
            <button type="button" onClick={() => onNavigate("events:new")}>
              <Icon name="plus" size={14} /> New event
            </button>
          )}
          <button
            type="button"
            className="ghost"
            onClick={() => void load()}
            aria-label="Refresh dashboard"
            disabled={refreshing}
          >
            <Icon name="refresh" size={14} className={refreshing ? "spin" : undefined} />
            {refreshing ? "Syncing" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="stat-strip-wrap">
        <div className="stat-grid">
          <Stat
            label="Live right now"
            value={data.events.live}
            sub={`${data.events.upcoming} ready or published`}
            icon="spark"
            tone="tone-mint"
          />
          <Stat
            label="Upcoming events"
            value={data.events.upcoming}
            sub={`${data.events.draft} drafts · ${data.events.pendingApprovals} in approval`}
            icon="calendar"
            tone="tone-brand"
          />
          <Stat
            label="Confirmed registrations"
            value={data.registrations.confirmed}
            sub={`${data.registrations.waitlisted} waitlisted · ${data.registrations.applied} applied`}
            icon="users"
            tone="tone-sky"
            trend={data.confirmationTrend.map((d) => d.confirmed)}
          />
          <div className="stat-card accent">
            <div className="stat-top">
              <span className="stat-label">Needs attention</span>
              <span className="stat-icon">
                <Icon name="bell" size={16} />
              </span>
            </div>
            <div className="stat-value">
              {data.work.approvalsPending +
                data.work.verificationPending +
                data.work.openComplaints}
            </div>
            {/* Number above its label, each pair in one element: the three
                columns used to read as a row of bare digits ("1 0 2") with the
                words detached underneath, so the tile meant nothing at a glance. */}
            <div className="stat-split">
              <span>
                <b>{data.work.approvalsPending}</b>
                <em>approvals</em>
              </span>
              <span>
                <b>{data.work.verificationPending}</b>
                <em>IDs</em>
              </span>
              <span>
                <b>{data.work.openComplaints}</b>
                <em>issues</em>
              </span>
            </div>
          </div>
        </div>
      </div>

      {nextEvent && (
        <NextUp event={nextEvent} isClubMember={isClubMember} onOpenEvent={onOpenEvent} />
      )}

      <div className="dash-grid">
        <div className="stack">
          <Card
            title="Confirmed registrations"
            subtitle={`The last fourteen days, by campus day. ${confirmedShare}% of applications confirmed.`}
            actions={
              <span className="badge info">
                {data.confirmationTrend.reduce((a, d) => a + d.confirmed, 0).toLocaleString()} in
                window
              </span>
            }
          >
            <TrendChart points={data.confirmationTrend} />
          </Card>
          <Card
            title={data.upcoming.length ? "On the horizon" : "Upcoming & live"}
            subtitle="Published events in your scope, soonest first."
            actions={
              isCoordinator ? (
                <button type="button" className="link" onClick={() => onNavigate("events")}>
                  All events <Icon name="chevron" size={13} />
                </button>
              ) : undefined
            }
          >
            {data.upcoming.length === 0 ? (
              <Empty
                title="No events on the calendar yet"
                icon="calendar"
                action={
                  isCoordinator ? (
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() => onNavigate("events:new")}
                    >
                      Start a draft
                    </button>
                  ) : undefined
                }
              >
                Published and ready events land here as soon as they clear approval.
              </Empty>
            ) : (
              <div className="event-list">
                {data.upcoming.map((e) => {
                  const d = new Date(e.startsAt);
                  const pct = e.capacity
                    ? Math.min(100, Math.round((e.confirmed / e.capacity) * 100))
                    : 0;
                  return (
                    <div className="event-item" key={e.id}>
                      <div className="event-date">
                        <div>
                          <b>{d.getDate()}</b>
                          <span>{d.toLocaleString([], { month: "short" })}</span>
                        </div>
                      </div>
                      <div className="ev-body">
                        <b>{e.title}</b>
                        <p className="meta">
                          {e.clubName} · {formatWhen(e.startsAt)} · {e.venueSummary ?? "Venue TBA"}
                        </p>
                        <div
                          className="progress"
                          aria-label={`${e.confirmed} of ${e.capacity} seats confirmed`}
                        >
                          <span style={{ width: `${pct}%` }} />
                        </div>
                        <span className="hint">
                          {e.confirmed}/{e.capacity} seats confirmed
                          {pct >= 90 ? " · almost full" : ""}
                        </span>
                      </div>
                      <div className="ev-side">
                        <EventBadge status={e.status} />
                        {isClubMember && (
                          <button
                            type="button"
                            className="ghost tiny"
                            onClick={() => onOpenEvent(e.id)}
                          >
                            Open <Icon name="arrow" size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title="On your desk" subtitle="Work that stops the day if it waits.">
            <div className="work-list">
              {workItems.map((w) => (
                <button
                  type="button"
                  className="work-item"
                  key={w.label}
                  onClick={() => onNavigate(w.tab)}
                >
                  <span className={`stat-icon ${w.tone}`}>
                    <Icon name={w.icon} size={16} />
                  </span>
                  <span>
                    <b>{w.label}</b>
                    <span>{w.sub}</span>
                  </span>
                  <span className="n">{w.n}</span>
                </button>
              ))}
            </div>
          </Card>
          <Card title="Event pipeline" subtitle="Where the term's events are sitting.">
            <Pipeline data={data} />
          </Card>
          <Card
            title="Next approvals"
            actions={
              isStaff ? (
                <button type="button" className="link" onClick={() => onNavigate("approvals")}>
                  Inbox <Icon name="chevron" size={13} />
                </button>
              ) : undefined
            }
          >
            {data.approvalQueue.length === 0 ? (
              <Empty title="Inbox zero" icon="inbox">
                No permission is waiting on your decision.
              </Empty>
            ) : (
              <div className="attn-list">
                {data.approvalQueue.slice(0, 4).map((a) => (
                  <div
                    className="queue-row"
                    key={a.request?.id ?? `${a.event?.id}-${a.request?.title}`}
                  >
                    <span className="stat-icon tone-brand">
                      <Icon name="inbox" size={14} />
                    </span>
                    <span className="q-body">
                      <b>{a.request?.title ?? "Approval request"}</b>
                      <span>
                        {a.event?.title ?? "Event"} · {a.club?.name ?? "Club"}
                      </span>
                    </span>
                    <span className="q-when">
                      {a.request?.dueAt ? formatWhen(a.request.dueAt) : "No due date"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <div className="dash-foot">
        <span>
          {SCOPE_NOTE[data.scope]} · updated{" "}
          {new Date(data.generatedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
          {tick > 1 ? " · live" : ""}
        </span>
        <span>
          CampusOps · <b>Event operations</b>
        </span>
      </div>
    </>
  );
});

function Stat({
  label,
  value,
  sub,
  icon,
  tone,
  trend,
}: {
  label: string;
  value: number;
  sub: string;
  icon: string;
  tone: string;
  trend?: number[];
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon ${tone}`}>
          <Icon name={icon} size={16} />
        </span>
      </div>
      <div className="stat-value">{value.toLocaleString()}</div>
      {trend && trend.length > 1 ? <Sparkline values={trend} /> : null}
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

function useCountdown(target: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const diff = Math.max(0, new Date(target).getTime() - now);
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return { days, hours, minutes, past: diff === 0 };
}

function NextUp({
  event,
  isClubMember,
  onOpenEvent,
}: {
  event: DashboardData["upcoming"][number];
  isClubMember: boolean;
  onOpenEvent: (id: string) => void;
}) {
  const countdown = useCountdown(event.startsAt);
  const live = event.status === "LIVE";
  const seats = event.capacity
    ? Math.min(100, Math.round((event.confirmed / event.capacity) * 100))
    : 0;
  return (
    <section className="next-up" aria-label="Next event up">
      <div className="next-up-body">
        <span className="next-up-label">
          <span className={`status-dot ${live ? "live" : ""}`} style={{ marginRight: 0 }} />
          {live ? "Live now" : "Next up"}
          {event.status !== "LIVE" && <EventBadge status={event.status} />}
        </span>
        <h2>{event.title}</h2>
        <div className="next-up-meta">
          <span>
            <Icon name="users" size={12} /> {event.clubName}
          </span>
          <span>
            <Icon name="clock" size={12} /> {formatWhen(event.startsAt)}
          </span>
          <span>
            <Icon name="pin" size={12} /> {event.venueSummary ?? "Venue TBA"}
          </span>
          <span>
            <Icon name="ticket" size={12} /> {event.confirmed}/{event.capacity} confirmed
          </span>
        </div>
        <div
          className="progress"
          style={{ marginTop: 8, maxWidth: 320, background: "rgba(246,241,229,.16)" }}
          aria-label={`${seats}% of seats confirmed`}
        >
          <span style={{ width: `${seats}%`, background: "var(--accent)" }} />
        </div>
        <div className="next-up-actions">
          {isClubMember ? (
            <button type="button" className="btn-quiet" onClick={() => onOpenEvent(event.id)}>
              Open event <Icon name="arrow" size={13} />
            </button>
          ) : (
            <span className="countdown-caption" style={{ textAlign: "left" }}>
              Visible in the event record
            </span>
          )}
        </div>
      </div>
      <div className="next-up-side">
        {live ? (
          <>
            <span className="countdown-caption">In progress</span>
            <span className="next-up-label" style={{ fontSize: 9 }}>
              Started {formatWhen(event.startsAt)}
            </span>
            <span className="countdown-caption">Ends {formatWhen(event.endsAt)}</span>
          </>
        ) : (
          <>
            <div className="countdown" role="timer" aria-label="Time until the event starts">
              <div className="countdown-unit">
                <b>{String(countdown.days).padStart(2, "0")}</b>
                <span>days</span>
              </div>
              <div className="countdown-unit">
                <b>{String(countdown.hours).padStart(2, "0")}</b>
                <span>hrs</span>
              </div>
              <div className="countdown-unit">
                <b>{String(countdown.minutes).padStart(2, "0")}</b>
                <span>min</span>
              </div>
            </div>
            <span className="countdown-caption">Until doors open</span>
          </>
        )}
      </div>
    </section>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const pts = values
    .map((v, i) => `${(i / Math.max(1, values.length - 1)) * 120},${26 - (v / max) * 22}`)
    .join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 120 30" aria-hidden="true" preserveAspectRatio="none">
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `day` is a campus-calendar YYYY-MM-DD key, not an instant. Format the parts
 * directly so a viewer in any browser timezone sees the same campus day.
 */
function campusDayLabel(day: string) {
  const [, month, date] = day.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? ""}`.trim();
}

function TrendChart({ points }: { points: Array<{ day: string; confirmed: number }> }) {
  const W = 720;
  const H = 216;
  const P = 34;
  const max = Math.max(1, ...points.map((p) => p.confirmed));
  const x = (i: number) => P + (i / Math.max(1, points.length - 1)) * (W - P * 2);
  const y = (v: number) => H - P - (v / max) * (H - P * 2);
  const line = points.map((p, i) => `${x(i)},${y(p.confirmed)}`).join(" ");
  const area = `${P},${H - P} ${line} ${W - P},${H - P}`;
  const ticks = [0, 0.5, 1];
  const empty = points.every((p) => p.confirmed === 0);
  const last = points[points.length - 1];
  return (
    <div className="chart-card">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Confirmed registrations per campus day for the last 14 days; maximum ${max} in a day`}
      >
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="chart-grid"
              x1={P}
              x2={W - P}
              y1={y(max * t)}
              y2={y(max * t)}
              strokeDasharray={t === 0 ? "0" : "3 5"}
            />
            <text x={P - 10} y={y(max * t) + 3} textAnchor="end">
              {Math.round(max * t)}
            </text>
          </g>
        ))}
        {!empty && <polygon points={area} fill="url(#trendFill)" />}
        <polyline
          className="chart-line"
          points={line}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((p, i) => (
          <g key={p.day}>
            <circle
              className="chart-dot"
              cx={x(i)}
              cy={y(p.confirmed)}
              r={p.confirmed ? 3 : 2}
              strokeWidth="1.6"
            >
              <title>
                {campusDayLabel(p.day)}: {p.confirmed} confirmed
              </title>
            </circle>
            {(i % 3 === 0 || i === points.length - 1) && (
              <text x={x(i)} y={H - 9} textAnchor="middle">
                {campusDayLabel(p.day)}
              </text>
            )}
          </g>
        ))}
        {last && last.confirmed > 0 && (
          <circle
            className="chart-dot-halo"
            cx={x(points.length - 1)}
            cy={y(last.confirmed)}
            r="7"
          />
        )}
      </svg>
      {empty && (
        <p className="hint" style={{ textAlign: "center" }}>
          No confirmations recorded in this window yet. The line fills as students register.
        </p>
      )}
    </div>
  );
}

function Pipeline({ data }: { data: DashboardData }) {
  const rows = [
    { label: "Draft", n: data.events.draft, color: "var(--muted)" },
    { label: "In approval", n: data.events.pendingApprovals, color: "var(--warn)" },
    { label: "Published / ready", n: data.events.upcoming, color: "var(--accent)" },
    { label: "Live", n: data.events.live, color: "var(--good)" },
    { label: "Completed", n: data.events.completed, color: "var(--info)" },
  ];
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="donut-legend" style={{ gap: 11 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "grid", gap: 4 }}>
          <div>
            <span>
              <i style={{ background: r.color }} />
              {r.label}
            </span>
            <strong>{r.n}</strong>
          </div>
          <div className="progress">
            <span style={{ width: `${(r.n / max) * 100}%`, background: r.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <div style={{ display: "grid", gap: 10, marginBottom: 22 }}>
        <Skeleton height={10} width={180} />
        <Skeleton height={40} width="min(440px, 70vw)" />
        <Skeleton height={13} width="min(520px, 84vw)" />
      </div>
      <div className="stat-grid">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat-card" key={i}>
            <Skeleton height={9} width={90} />
            <Skeleton height={34} width={64} />
            <Skeleton height={10} width="72%" />
          </div>
        ))}
      </div>
      <div className="dash-grid" style={{ marginTop: 16 }}>
        <div className="stack">
          <div className="card">
            <Skeleton height={16} width={200} />
            <div style={{ marginTop: 20 }}>
              <Skeleton height={216} />
            </div>
          </div>
          <div className="card">
            <Skeleton height={16} width={150} />
            <div style={{ marginTop: 18, display: "grid", gap: 16 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <Skeleton height={44} width={44} />
                  <div style={{ flex: 1, display: "grid", gap: 7 }}>
                    <Skeleton height={12} width="52%" />
                    <Skeleton height={10} width="74%" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="stack">
          {[0, 1].map((i) => (
            <div className="card" key={i}>
              <Skeleton height={16} width={120} />
              <div style={{ marginTop: 18, display: "grid", gap: 14 }}>
                <Skeleton height={12} />
                <Skeleton height={12} width="86%" />
                <Skeleton height={12} width="70%" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
