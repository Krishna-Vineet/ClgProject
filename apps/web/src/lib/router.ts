import { useEffect, useState } from "react";

/**
 * A tiny "is a route transition in flight?" signal.
 *
 * The console is one hash-driven tab at a time (see App.tsx), and each tab is a
 * lazily imported chunk. Between the click and the chunk arriving there is a
 * gap where the old tab is still on screen and nothing has happened yet — which
 * reads as a dropped click. This store lets the shell show a progress bar for
 * exactly that window without a routing library.
 */
let pending = 0;
const listeners = new Set<() => void>();

function announce() {
  for (const fn of listeners) fn();
}

export function beginRoute() {
  pending += 1;
  announce();
}

export function endRoute() {
  pending = Math.max(0, pending - 1);
  announce();
}

/** Marks the next paint as the end of the transition. */
export function endRouteSoon() {
  requestAnimationFrame(() => requestAnimationFrame(endRoute));
}

export function useRouterLoading() {
  const [loading, setLoading] = useState(pending > 0);
  useEffect(() => {
    const update = () => setLoading(pending > 0);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return loading;
}
