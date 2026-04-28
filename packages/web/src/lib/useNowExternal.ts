// Singleton-timer "now" hook, subscribed to via useSyncExternalStore.
//
// The motivating problem: a per-second "now" that lives inside a
// component (`useNow`) re-renders that component every second, which
// re-renders its entire subtree — even with `memo`'d children, React
// still has to reconcile and walk the parent's JSX. With ~50 feed
// rows and per-second ticks the work adds up.
//
// useSyncExternalStore inverts the wiring: the timer lives outside
// React entirely, components subscribe directly, and a tick only
// re-renders the components that read the value. Parents that don't
// call this hook stay completely still.
//
// One tick per second across the whole app, started lazily on first
// subscribe and torn down on last unsubscribe.

import { useSyncExternalStore } from "react";

let now = Date.now();
const subscribers = new Set<() => void>();
let timerId: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  now = Date.now();
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (timerId == null) {
    // Align to the next wall-clock second so all subscribers tick in
    // unison — avoids each row re-rendering at a slightly different
    // instant when the page first mounts.
    const offset = 1000 - (Date.now() % 1000);
    timerId = setTimeout(() => {
      timerId = setInterval(notify, 1000);
      notify();
    }, offset);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timerId != null) {
      // Either flavour of timer id works for both clearTimeout +
      // clearInterval — same numeric handle in node + browser. We
      // clear both intentionally because we may still be in the
      // alignment timeout when the last subscriber leaves.
      clearTimeout(timerId);
      clearInterval(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): number {
  return now;
}

/** Subscribe to the shared 1 Hz ticker. Returns the latest
 * `Date.now()` value. Components calling this re-render once per
 * second; their parents don't unless they call it too. */
export function useNowSeconds(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
