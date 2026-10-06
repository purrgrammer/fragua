// Worker policy for the `agent` tool: the per-turn concurrency semaphore, the
// operator-ceiling cap resolution, and the admission rule for model-supplied
// context-file paths. Pure; no model or store access.

/** Resolved caps for the `agent` tool. Every field optional; the tool applies
 * built-in defaults (max-turns 50, timeout-minutes 15, concurrency 4) when a
 * value is absent, and leaves `maxCostUsd` unbounded when unset. These are the
 * operator's CEILINGS: a per-call `max_cost_usd` / `timeout_minutes` argument
 * can only tighten them, never exceed them (`resolveWorkerCaps`). */
export interface AgentToolConfig {
  maxCostUsd?: number;
  maxTurns?: number;
  timeoutMinutes?: number;
  /** Concurrent workers per caller TURN (the semaphore is built per llm
   * dispatch). A sequential caller therefore never exceeds it run-wide; the
   * branches of a `parallel` node are separate dispatches and each get their
   * own allowance. */
  concurrency?: number;
}

/** Config-cascade default turn cap for a worker that spends little but never
 * stops (`agent.max-turns`). */
export const DEFAULT_AGENT_MAX_TURNS = 50;
/** Config-cascade default for concurrent workers per caller turn
 * (`agent.concurrency`). pi-agent-core executes one assistant message's tool
 * calls in parallel, so N `agent` calls in one message would otherwise be N
 * unbounded concurrent model loops over one worktree. */
export const DEFAULT_AGENT_CONCURRENCY = 4;

/** Counting semaphore for worker slots within one caller turn. `acquire`
 * resolves with a release fn once a slot is free, or rejects with
 * `WorkerSlotsAborted` if `signal` fires first — so a caller abort never
 * leaves a queued worker waiting on a slot that will not come. */
export class WorkerSlots {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError(`WorkerSlots: limit must be a positive integer, got ${limit}`);
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.inUse += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.inUse -= 1;
          this.waiters.shift()?.();
        });
      };
      // Honour an already-fired abort BEFORE handing out a free slot: a worker
      // queued after the caller's turn aborted must never start.
      if (signal?.aborted) {
        reject(new WorkerSlotsAborted());
        return;
      }
      if (this.inUse < this.limit) {
        grant();
        return;
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new WorkerSlotsAborted());
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(new WorkerSlotsAborted());
          return;
        }
        grant();
      };
      this.waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export class WorkerSlotsAborted extends Error {
  constructor() {
    super("worker aborted while waiting for a concurrency slot");
    this.name = "WorkerSlotsAborted";
  }
}
/** Config-cascade default wall-clock cap for a worker (`agent.timeout-minutes`). */
export const DEFAULT_AGENT_TIMEOUT_MINUTES = 15;
/** A model-supplied `context_files` entry must be a plain relative path: no
 * leading `/` or drive, no `..` segment, no NUL. Symlinks that leave the tree
 * are the realpath jail's job. */
export function isWorktreeRelativePath(path: string): boolean {
  const p = path.trim();
  if (p.length === 0 || p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]+/).some((seg) => seg === "..");
}

/** The caps one worker runs under, innermost first. The operator's config is a
 * CEILING the model can only tighten: a per-call `max_cost_usd` /
 * `timeout_minutes` above it (or absent, or non-positive) resolves to the
 * ceiling itself; `max-turns` is operator-only. Without an operator `max-cost`
 * the call's own cap is the only one. An operator `timeout-minutes` of 0 means
 * "no wall-clock ceiling": a call may still give ITSELF a finite cap (tightening
 * is always allowed), and absent a call cap the worker runs uncapped. */
export function resolveWorkerCaps(
  args: { max_cost_usd?: number; timeout_minutes?: number },
  config: AgentToolConfig,
): { maxCostUsd: number | undefined; maxTurns: number; timeoutMinutes: number } {
  const costArg = typeof args.max_cost_usd === "number" && args.max_cost_usd > 0 ? args.max_cost_usd : undefined;
  const costCeiling = config.maxCostUsd;
  const maxCostUsd = costCeiling !== undefined ? Math.min(costArg ?? costCeiling, costCeiling) : costArg;

  const timeoutArg =
    typeof args.timeout_minutes === "number" && args.timeout_minutes > 0 ? args.timeout_minutes : undefined;
  const timeoutCeiling = config.timeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES;
  const timeoutMinutes =
    timeoutCeiling > 0 ? Math.min(timeoutArg ?? timeoutCeiling, timeoutCeiling) : (timeoutArg ?? 0);

  return { maxCostUsd, maxTurns: config.maxTurns ?? DEFAULT_AGENT_MAX_TURNS, timeoutMinutes };
}
