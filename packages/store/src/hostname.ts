import { hostname as osHostname } from "node:os";

/** `os.hostname()` throws synchronously on hardened hosts (a seccomp profile
 *  blocking `uname(2)`, or a container without a UTS namespace). Every lifecycle
 *  site that stamps a hostname must tolerate that rather than crash. Shared by
 *  the CLI and the daemon so the `daemon_lock.hostname` fallback is one string. */
export function hostnameSafe(): string {
  try {
    return osHostname();
  } catch {
    return "unknown";
  }
}
