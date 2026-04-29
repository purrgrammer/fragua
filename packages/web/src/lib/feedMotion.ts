// Motion config for live-updating list rows on the Control Center.
// Used by Activity (GlobalFeed), Inbox, and Running. Keeping the
// timing/easing in one place stops the three sections from drifting
// out of sync.
//
// 180ms ease-out-cubic for the entrance — under the 250ms ceiling
// (operators see these all day). Only `transform` + `opacity`, so
// rows stay on the GPU and don't trigger layout. Exit is opacity-only
// so the row stays in place while it dissolves; the parent's
// `layout` (when set) carries the reflow.

import type { TargetAndTransition, Transition } from "motion/react";

const EASE_OUT_CUBIC: [number, number, number, number] = [0.215, 0.61, 0.355, 1];
const ENTER_DURATION_S = 0.18;

export interface RowMotion {
  initial: false | TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition | undefined;
  transition: Transition;
}

function build(reduce: boolean, yFrom: number): RowMotion {
  return {
    initial: reduce ? false : { opacity: 0, y: yFrom, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: reduce ? undefined : { opacity: 0 },
    transition: reduce ? { duration: 0 } : { duration: ENTER_DURATION_S, ease: EASE_OUT_CUBIC },
  };
}

/** Motion for a row that enters from above — newest-at-top lists
 *  (Activity, Running). */
export function rowEnterFromTop(reduce: boolean): RowMotion {
  return build(reduce, -6);
}

/** Motion for a row that enters from below — oldest-at-top lists where
 *  new items append at the bottom (Inbox). */
export function rowEnterFromBottom(reduce: boolean): RowMotion {
  return build(reduce, 6);
}
