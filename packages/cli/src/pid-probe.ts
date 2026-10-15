export type PidState = "alive" | "dead" | "unknown";

/** `process.kill(pid, 0)` liveness probe: send no signal, just test whether the
 *  pid is reachable. `ESRCH` → the process is gone (`"dead"`); a successful
 *  probe → `"alive"`; `EPERM` → the pid exists but belongs to another user, so
 *  we can't attribute it to our process (a recycled pid is common in small PID
 *  namespaces) — `"unknown"`. Only `ESRCH` yields `"dead"`: every other errno
 *  (EINVAL, and whatever a future runtime adds) is a probe we could not
 *  complete, and treating it as dead would act on a failure to know. Only
 *  meaningful for a pid on THIS host. */
export function probePidState(pid: number): PidState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}
