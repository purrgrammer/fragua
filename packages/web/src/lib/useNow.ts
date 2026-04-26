import { useEffect, useState } from "react";

/**
 * Returns a `Date.now()`-style timestamp that re-renders every `intervalMs`.
 * When `enabled` is false the interval is never created (zero re-render cost
 * on terminal runs and on rows that already have a final `durationMs`).
 */
export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}
