// `fragua judge calibrate [workflow]` — read every gate's answers back out of
// history and show where they landed relative to the bound the workflow
// authored.
//
// TypeSafe's own guidance for picking a threshold is labelled examples plus
// the cost of a wrong action; short of that, the next best thing is the
// distribution a gate actually sees. Every judge answer is already in the
// event log, so this needs no new runs and no labelling: it prints, per gate,
// how many reads sat inside the model's uncertain band and how many sat close
// enough to the bound that a re-run could land on the other side.

import { deserializeGraph, type JudgeThreshold } from "@fragua/core";
import chalk from "chalk";
import { withStoreClient } from "../store-client.ts";

export interface JudgeCalibrateOptions {
  dbPath?: string;
  /** Narrow to one workflow by display name. Default: every workflow. */
  workflow?: string;
  /** Half-width of the flip-risk window around a bound. Default 0.10. */
  margin?: number;
}

/** The band TypeSafe's own cookbooks route to a human: outside it the answer
 * is a yes or a no, inside it the model is reporting that it is unsure. */
const UNCERTAIN_LO = 0.3;
const UNCERTAIN_HI = 0.7;
const DEFAULT_MARGIN = 0.1;

interface Gate {
  /** `keep`, `review`, `decide.outcome`, or `decide.route`. */
  source: string;
  bound: JudgeThreshold;
}

interface Reads {
  /** Every bound that tests this question. `keep` and `review` both bound the
   * same noul, and each wants its own line. */
  gates: Gate[];
  values: number[];
}

/** Every noul / composite bound a judge node authors, by question id. */
function gatesOf(attrs: Record<string, unknown>): Map<string, Gate[]> {
  const out = new Map<string, Gate[]>();
  const add = (source: string, rules: readonly JudgeThreshold[] | undefined): void => {
    for (const r of rules ?? []) out.set(r.question, [...(out.get(r.question) ?? []), { source, bound: r }]);
  };
  const keep = attrs["judge_keep"] as { rules: JudgeThreshold[] } | undefined;
  const review = attrs["judge_review"] as { rules: JudgeThreshold[] } | undefined;
  const decide = attrs["judge_decide"] as
    | { outcome?: { rules: JudgeThreshold[] }; route?: { question: string; min_confidence?: number } }
    | undefined;
  add("keep", keep?.rules);
  add("review", review?.rules);
  add("decide.outcome", decide?.outcome?.rules);
  if (decide?.route?.min_confidence !== undefined) {
    add("decide.route", [{ question: decide.route.question, min: decide.route.min_confidence }]);
  }
  return out;
}

/** The single number a gate reads off an answer: a noul's probability, or a
 * choice's confidence when the gate is a routing floor. */
function readValue(answer: unknown, gates: readonly Gate[]): number | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const a = answer as Record<string, unknown>;
  if (a["type"] === "noul" && typeof a["noul"] === "number") return a["noul"];
  if (gates.some((g) => g.source === "decide.route") && typeof a["confidence"] === "number") {
    return a["confidence"];
  }
  return undefined;
}

function describeBound(b: JudgeThreshold): string {
  const parts: string[] = [];
  if (b.min !== undefined) parts.push(`>= ${b.min}`);
  if (b.max !== undefined) parts.push(`<= ${b.max}`);
  return parts.join(" ");
}

/** Distance from the nearest bound the rule actually tests. */
function distanceToBound(b: JudgeThreshold, v: number): number {
  const ds: number[] = [];
  if (b.min !== undefined) ds.push(Math.abs(v - b.min));
  if (b.max !== undefined) ds.push(Math.abs(v - b.max));
  return ds.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...ds);
}

export function judgeCalibrateCommand(opts: JudgeCalibrateOptions): Promise<number> {
  const margin = opts.margin ?? DEFAULT_MARGIN;
  return withStoreClient(opts, ({ store }) => {
    const rows = store.getJudgeMessages(opts.workflow);
    if (rows.length === 0) {
      const scope = opts.workflow === undefined ? "this store" : `workflow "${opts.workflow}"`;
      console.log(`no judge answers recorded in ${scope}`);
      return 0;
    }

    // workflow -> node -> question -> reads. Bounds come from the graph the
    // run executed, so a threshold edited since is compared against its own
    // runs rather than against today's number.
    const byWorkflow = new Map<string, Map<string, Map<string, Reads>>>();
    const gateCache = new Map<string, Map<string, Gate[]>>();
    const seenRuns = new Set<string>();

    for (const row of rows) {
      if (row.nodeId == null) continue;
      seenRuns.add(row.runId);
      let parsed: { role?: string; answers?: Record<string, unknown> };
      try {
        parsed = JSON.parse(row.content) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.role !== "judge_node" || parsed.answers === undefined) continue;

      const cacheKey = `${row.workflowSha}::${row.nodeId}`;
      let gates = gateCache.get(cacheKey);
      if (gates === undefined) {
        const wf = store.getWorkflow(row.workflowSha);
        const node = wf === null ? undefined : deserializeGraph(wf.ir).nodes[row.nodeId];
        gates = node === undefined ? new Map<string, Gate[]>() : gatesOf(node.attrs as Record<string, unknown>);
        gateCache.set(cacheKey, gates);
      }

      const wfName = row.workflowName ?? row.workflowSha.slice(0, 8);
      const nodes = byWorkflow.get(wfName) ?? new Map<string, Map<string, Reads>>();
      byWorkflow.set(wfName, nodes);
      const questions = nodes.get(row.nodeId) ?? new Map<string, Reads>();
      nodes.set(row.nodeId, questions);

      for (const [rawId, answer] of Object.entries(parsed.answers)) {
        // A for-each judge keys its answers `<question>__<item index>`; every
        // item is another read of the same gate.
        const id = rawId.split("__")[0] ?? rawId;
        const nodeGates = gates.get(id) ?? [];
        const value = readValue(answer, nodeGates);
        if (value === undefined) continue;
        const reads = questions.get(id) ?? { gates: nodeGates, values: [] };
        reads.values.push(value);
        questions.set(id, reads);
      }
    }

    let totalGated = 0;
    let totalNear = 0;
    let totalBand = 0;

    console.log(chalk.bold("judge calibrate"));
    console.log(
      chalk.dim(
        `  ${seenRuns.size} run(s) · flip-risk window +/-${margin} · uncertain band ${UNCERTAIN_LO}-${UNCERTAIN_HI}`,
      ),
    );
    for (const [wf, nodes] of [...byWorkflow].sort()) {
      const gatedNodes = [...nodes].sort().filter(([, qs]) => [...qs.values()].some((r) => r.gates.length > 0));
      if (gatedNodes.length === 0) continue;
      console.log(`\n${chalk.bold(wf)}`);
      for (const [nodeId, questions] of gatedNodes) {
        console.log(`  ${chalk.cyan(nodeId)}`);
        for (const [qid, reads] of [...questions].sort()) {
          const vs = reads.values;
          if (vs.length === 0) continue;
          const band = vs.filter((v) => v >= UNCERTAIN_LO && v <= UNCERTAIN_HI).length;
          const pct = (k: number): string => `${Math.round((k / vs.length) * 100)}%`;
          // The same reads, once per bound that tests them. Only the primary
          // decision counts toward the totals, so a `review:` band beside a
          // `keep:` does not double-count its own question.
          reads.gates.forEach((gate, i) => {
            const near = vs.filter((v) => distanceToBound(gate.bound, v) <= margin).length;
            if (i === 0) {
              totalGated += vs.length;
              totalNear += near;
              totalBand += band;
            }
            const nearText = near === 0 ? chalk.green("0") : chalk.yellow(`${near} (${pct(near)})`);
            console.log(
              `    ${(i === 0 ? qid : "").padEnd(16)} ${chalk.dim(gate.source.padEnd(14))}` +
                ` ${describeBound(gate.bound).padEnd(13)}` +
                ` n=${String(vs.length).padStart(4)}  near bound ${nearText}` +
                `  uncertain ${band} (${pct(band)})` +
                `  ${chalk.dim(`range ${Math.min(...vs).toFixed(2)}-${Math.max(...vs).toFixed(2)}`)}`,
            );
          });
        }
      }
    }

    if (totalGated === 0) {
      console.log("\nno gated questions — every judge here is a pure producer");
      return 0;
    }
    const pct = (k: number): number => Math.round((k / totalGated) * 100);
    console.log(
      `\n${totalGated} gate read(s): ${totalNear} (${pct(totalNear)}%) within ${margin} of their bound, ` +
        `${totalBand} (${pct(totalBand)}%) inside the uncertain band`,
    );
    console.log(
      chalk.dim(
        "  a read near its bound can land on the other side on a re-run; a read inside the band is one the\n" +
          "  model reports as unsure — consider a `review:` band, or a bound further from where the mass sits",
      ),
    );
    return 0;
  });
}
