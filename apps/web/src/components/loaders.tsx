import { type ReactNode, useEffect, useRef, useState } from "react";
import { useRouterLoading } from "../lib/router";
import { Icon } from "./icons";

/**
 * The one spinner.
 *
 * It is an inline SVG with its own keyframes rather than a CSS border trick, so
 * it can be scaled, recoloured and composed inside a button or a full-page
 * overlay without changing shape. The dash offset animates as well as the
 * rotation, which reads as motion even when the screen is busy.
 */
export function Spinner({
  size = 18,
  label,
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <output
      className={`spinner${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-label={label ?? "Loading"}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
        <title>Loading</title>
        <circle className="spinner-track" cx="12" cy="12" r="9" />
        <circle className="spinner-head" cx="12" cy="12" r="9" />
      </svg>
    </output>
  );
}

/** A button that is working: spinner replaces the label without changing size. */
export function BusyLabel({ busy, children }: { busy: boolean; children: ReactNode }) {
  return busy ? (
    <span className="busy-label">
      <Spinner size={13} />
      <span>Working…</span>
    </span>
  ) : (
    <>{children}</>
  );
}

/**
 * A block-level loading state: a spinner, the reason, and skeleton shapes in the
 * rhythm of what is coming. Used inside a card where the panel knows the shape
 * of its own content.
 */
export function LoadingPanel({
  label = "Loading…",
  rows = 3,
  compact = false,
}: {
  label?: string;
  rows?: number;
  compact?: boolean;
}) {
  return (
    <div
      className={`loading-panel${compact ? " is-compact" : ""}`}
      aria-busy="true"
      aria-live="polite"
    >
      <span className="loading-panel-head">
        <Spinner size={15} />
        <span className="loading-label">{label}</span>
      </span>
      {compact ? null : (
        <span className="skeleton-text" aria-hidden="true">
          {Array.from({ length: rows }, (_, i) => `${i}`).map((id, i) => (
            <span
              key={id}
              className="skeleton"
              style={{ height: 12, width: `${[92, 74, 84, 61][i % 4]}%` }}
            />
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * A dimming veil over the box it is placed in, with a spinner in the middle.
 *
 * Position is the parent's job (`position: relative`), which is why this is a
 * sibling overlay rather than a wrapper: panels keep their layout and only gain
 * a layer while a save is in flight. `inert`-style blocking comes from the
 * pointer-events rule on `.box-loading`.
 */
export function BoxLoader({ label }: { label?: string }) {
  return (
    <output className="box-loading" aria-live="polite" aria-busy="true">
      <span className="box-loading-card">
        <Spinner size={20} />
        {label ? <span className="loading-label">{label}</span> : null}
      </span>
    </output>
  );
}

/**
 * Full-viewport loader used while the app boots and while a route chunk loads.
 * It fades itself in (so a 40 ms load does not flash) and out, and it is
 * `aria-busy` rather than a dialog so it never steals focus.
 */
export function FullPageLoader({ label = "Loading" }: { label?: string }) {
  const [visible, setVisible] = useState(false);
  // Nothing under ~120 ms should show a loader: it reads as a flicker, not
  // progress. The delay is shorter than a human-noticeable pause.
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 110);
    return () => clearTimeout(timer);
  }, []);
  return (
    <output
      className={`page-loader${visible ? " is-visible" : ""}`}
      aria-label={label}
      aria-busy="true"
      aria-live="polite"
    >
      <div className="page-loader-mark" aria-hidden="true">
        <svg
          viewBox="0 0 160 160"
          className="page-loader-sketch"
          aria-hidden="true"
          focusable="false"
        >
          <title>Loading</title>
          {/* a hand-drawn arc, drawn in as the page loads */}
          <path
            d="M22 96c8-38 34-64 68-64 30 0 52 20 58 50"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeDasharray="2 7"
          />
          <path
            d="M14 118c14-9 30-13 48-13s35 4 49 13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.45"
          />
        </svg>
        <Spinner size={26} />
      </div>
      <span className="page-loader-label">{label}</span>
      <span className="page-loader-track" aria-hidden="true">
        <span className="page-loader-bar" />
      </span>
    </output>
  );
}

/** Top-of-window progress bar for route changes. */
export function RouteProgress() {
  const loading = useRouterLoading();
  const [progress, setProgress] = useState(0);
  const [active, setActive] = useState(false);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (doneTimer.current) clearTimeout(doneTimer.current);
    if (loading) {
      setActive(true);
      setProgress(12);
      // Creep toward 80% and wait there: a bar that reaches 100% before the work
      // is done is a lie, and one that stalls at 40% looks broken.
      const creep = setInterval(() => setProgress((p) => (p < 80 ? p + (90 - p) * 0.12 : p)), 180);
      return () => clearInterval(creep);
    }
    setProgress(100);
    doneTimer.current = setTimeout(() => {
      setActive(false);
      setProgress(0);
    }, 320);
    return undefined;
  }, [loading]);

  if (!active) return null;
  return (
    <div className="route-progress" role="presentation" aria-hidden="true">
      <span style={{ width: `${progress}%` }} />
    </div>
  );
}

/** Shown when a lazily loaded route fails, so a chunk error is not a blank page. */
export function RouteError({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="route-error">
      <span className="route-error-mark" aria-hidden="true">
        <Icon name="alert" size={18} />
      </span>
      <div>
        <strong>This section did not load.</strong>
        <p className="meta">{error.message}</p>
      </div>
      <button type="button" className="ghost" onClick={retry ?? (() => location.reload())}>
        Try again
      </button>
    </div>
  );
}
