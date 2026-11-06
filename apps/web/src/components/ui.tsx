import {
  APPROVAL_TIER_LABELS,
  type ApprovalStatus,
  type EventStatus,
  type ReservationStatus,
} from "@campusops/shared/ui";
import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
} from "react";
import { useToast } from "./feedback";
import { Icon } from "./icons";
import { Sketch, type SketchName } from "./sketch";

/** Empty-state illustrations, keyed by the icon the caller already passes. */
const SKETCH_FOR_ICON: Record<string, SketchName> = {
  compass: "campus",
  calendar: "calendar",
  check: "checklist",
  ticket: "ticket",
  room: "room",
  megaphone: "megaphone",
  clipboard: "clipboard",
  chart: "chart",
  search: "search",
  inbox: "inbox",
  key: "key",
  flag: "spark",
};

/**
 * Announce a message instead of drawing it inline.
 *
 * Panels used to set `error`/`notice` state and render an `ErrorNote` /
 * `SuccessNote` bar at the top of their card. That put the answer in a different
 * place from the button that caused it — often scrolled out of view — and made
 * every panel invent its own placement. This hook keeps the same call shape at
 * the call site but sends the message to the toast layer, which lives in the top
 * layer and is therefore visible over a modal too.
 *
 * The `<ErrorNote>` / `<SuccessNote>` components below still exist for genuinely
 * persistent conditions (a failed integrity check, a form validation summary) —
 * those must stay on screen. Anything that is a *response to an action* is a
 * toast.
 *
 * A null message is ignored, and repeating the same text within a moment is
 * collapsed, because several panels re-derive the same error on every render.
 */
export function useNotice(error: string | null, notice: string | null) {
  const toast = useToast();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!error) return;
    if (seen.current === `e:${error}`) return;
    seen.current = `e:${error}`;
    toast.err(error);
  }, [error, toast]);
  useEffect(() => {
    if (!notice) return;
    if (seen.current === `n:${notice}`) return;
    seen.current = `n:${notice}`;
    toast.ok(notice);
  }, [notice, toast]);
}

/**
 * A surface with a title. `subtitle` is for one line of context; anything longer
 * belongs in the body. The heading stays an h2 so the document outline is
 * predictable: h1 is the page, h2 is a section.
 */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  id,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ""}`} id={id}>
      <div className="card-head">
        <div className="card-head-text">
          <h2>{title}</h2>
          {subtitle ? <p className="card-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

const EVENT_TONE: Record<EventStatus, string> = {
  DRAFT: "muted",
  PENDING_APPROVALS: "warn",
  READY: "info",
  PUBLISHED: "good",
  LIVE: "good",
  COMPLETED: "muted",
  CANCELLED: "bad",
};

const APPROVAL_TONE: Record<ApprovalStatus, string> = {
  PENDING: "warn",
  APPROVED: "good",
  REJECTED: "bad",
  CHANGES_REQUESTED: "warn",
  CANCELLED: "muted",
};

const RESERVATION_TONE: Record<ReservationStatus, string> = {
  HELD: "warn",
  CONFIRMED: "good",
  RELEASED: "muted",
  EXPIRED: "bad",
};

const EVENT_LABEL: Record<EventStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVALS: "In approval",
  READY: "Ready",
  PUBLISHED: "Published",
  LIVE: "Live",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function EventBadge({ status }: { status: EventStatus }) {
  return <span className={`badge ${EVENT_TONE[status]}`}>{EVENT_LABEL[status]}</span>;
}

export function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  return (
    <span className={`badge ${APPROVAL_TONE[status]}`}>
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

export function ReservationBadge({ status }: { status: ReservationStatus }) {
  return <span className={`badge ${RESERVATION_TONE[status]}`}>{status.toLowerCase()}</span>;
}

/**
 * Wraps a single control. The label is explicitly associated with it via a
 * generated id so screen readers announce the field name.
 */
export function Field({
  label,
  children,
  hint,
}: { label: string; children: ReactNode; hint?: string | undefined }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string }>, { id })
        : children}
      {hint ? <small className="hint">{hint}</small> : null}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  return message ? (
    <p className="note bad-note" role="alert">
      <Icon name="alert" size={15} /> <span>{message}</span>
    </p>
  ) : null;
}

export function SuccessNote({ message }: { message: string | null }) {
  return message ? (
    <output className="note good-note">
      <Icon name="check-circle" size={15} /> <span>{message}</span>
    </output>
  ) : null;
}

/**
 * An empty state that says what is missing and, where the panel knows a next
 * step, offers it. Panels that only pass text still read as designed rather
 * than as an unhandled blank.
 */
export function Empty({
  children,
  title,
  icon = "compass",
  action,
}: {
  children?: ReactNode;
  title?: string;
  icon?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {/* A drawn figure in every empty state, chosen by the caller's icon so the
          illustration matches the subject ("no rooms yet" draws a room). */}
      <span className="empty-mark" aria-hidden="true">
        <Sketch name={SKETCH_FOR_ICON[icon] ?? "spark"} width={72} height={72} />
      </span>
      <div className="empty-copy">
        {title ? <strong>{title}</strong> : null}
        {children ? <span>{children}</span> : null}
      </div>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Skeleton({
  height = 14,
  width,
  radius,
  className,
}: {
  height?: number | string;
  width?: number | string;
  radius?: number;
  className?: string;
}) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ""}`}
      style={{
        height,
        width: width ?? "100%",
        ...(radius === undefined ? {} : { borderRadius: radius }),
      }}
      aria-hidden="true"
    />
  );
}

/** A paragraph-shaped placeholder. Widths vary so it does not look mechanical. */
const SKELETON_LINES = ["l1", "l2", "l3", "l4", "l5"];
const SKELETON_ROWS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"];

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  const widths = ["100%", "92%", "64%", "84%", "48%"];
  return (
    <span className="skeleton-text" aria-hidden="true">
      {SKELETON_LINES.slice(0, lines).map((id, i) => (
        <span
          key={id}
          className="skeleton"
          style={{ height: 11, width: widths[i % widths.length] }}
        />
      ))}
    </span>
  );
}

/** Table placeholder matching the real row rhythm. */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {SKELETON_ROWS.slice(0, rows).map((id, i) => (
        <div className="skeleton-row" key={id} style={{ opacity: 1 - i * 0.12 }}>
          <span className="skeleton" style={{ height: 12, width: `${34 + ((i * 13) % 26)}%` }} />
          <span className="skeleton" style={{ height: 12, width: "14%" }} />
          <span className="skeleton" style={{ height: 22, width: 76, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

/** Page-title placeholder used while a lazily loaded panel resolves. */
export function PanelSkeleton() {
  return (
    <div className="panel-skeleton" aria-busy="true" aria-label="Loading this section">
      <Skeleton height={10} width={112} />
      <Skeleton height={40} width="min(420px, 62vw)" />
      <Skeleton height={14} width="min(560px, 86vw)" />
      <div className="panel-skeleton-grid">
        <Skeleton height={260} />
        <Skeleton height={260} />
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** The campus runs on one clock, whatever the visitor's device is set to. */
export const CAMPUS_TIME_ZONE = "Asia/Kolkata";

export function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    timeZone: CAMPUS_TIME_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A short campus-style date, e.g. "Mon 3 Nov". */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    timeZone: CAMPUS_TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** datetime-local inputs need a local ISO string without the zone suffix. */
export function toLocalInput(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CAMPUS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${at("year")}-${at("month")}-${at("day")}T${at("hour")}:${at("minute")}`;
}

export function fromLocalInput(value: string): string {
  const withTime = value.length === 10 ? `${value}T00:00` : value;
  const withSeconds = withTime.length === 16 ? `${withTime}:00` : withTime;
  // India has no daylight saving, so a fixed offset is the campus wall clock.
  return new Date(`${withSeconds}+05:30`).toISOString();
}

/** Kept for callers that only need a tier label. */
export function tierLabel(tier: keyof typeof APPROVAL_TIER_LABELS): string {
  return APPROVAL_TIER_LABELS[tier];
}
