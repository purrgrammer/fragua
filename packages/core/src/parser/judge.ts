// `type: judge` step blocks — `state:` / `questions:` / `decide:` /
// `state-max-bytes`. Structural shape only: what the System One API would
// reject with a 422 is rejected here with a line number instead. Graph-level
// consistency (a `decide.route` question exists and is a `choice`, its
// criteria keys match `routes:`, …) is the validator's (E047–E051).

import {
  isJudgeIdentifier,
  JUDGE_DEFAULT_STATE_MAX_BYTES,
  JUDGE_HARD_STATE_MAX_BYTES,
  type JudgeDecide,
  type JudgeJson,
  type JudgeQuestion,
  type JudgeState,
} from "../types/judge.ts";

export class JudgeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeParseError";
  }
}

const QUESTION_TYPES = new Set(["choice", "score", "noul"]);
const QUESTION_KEYS = new Set(["type", "instructions", "criteria"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asJson(v: unknown, path: string): JudgeJson {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x, i) => asJson(x, `${path}[${i}]`));
  if (isPlainObject(v)) {
    const out: { [k: string]: JudgeJson } = {};
    for (const [k, x] of Object.entries(v)) out[k] = asJson(x, `${path}.${k}`);
    return out;
  }
  throw new JudgeParseError(`${path}: unsupported YAML value (${typeof v})`);
}

function nonEmptyText(v: JudgeJson): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return false;
}

export function parseJudgeQuestions(raw: unknown): Record<string, JudgeQuestion> {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    throw new JudgeParseError("`questions:` must be a non-empty mapping of question id → question");
  }
  const out: Record<string, JudgeQuestion> = {};
  for (const [id, q] of Object.entries(raw)) {
    if (!isJudgeIdentifier(id)) {
      throw new JudgeParseError(
        `question id "${id}" is not a valid identifier (must start with a letter, then letters/digits/underscore — it becomes an output key)`,
      );
    }
    if (!isPlainObject(q)) throw new JudgeParseError(`question "${id}" must be a mapping`);
    for (const k of Object.keys(q)) {
      if (!QUESTION_KEYS.has(k)) {
        throw new JudgeParseError(`question "${id}" has unknown key "${k}" (expected type / instructions / criteria)`);
      }
    }
    const type = q["type"];
    if (typeof type !== "string" || !QUESTION_TYPES.has(type)) {
      throw new JudgeParseError(
        `question "${id}" has unknown type ${JSON.stringify(type)} (expected choice / score / noul)`,
      );
    }
    const instructions = asJson(q["instructions"] ?? null, `question "${id}".instructions`);
    if (!nonEmptyText(instructions)) {
      throw new JudgeParseError(`question "${id}" needs non-empty \`instructions\``);
    }
    const criteria = q["criteria"];
    if (type === "choice") {
      if (!isPlainObject(criteria) || Object.keys(criteria).length < 2) {
        throw new JudgeParseError(
          `choice question "${id}" needs \`criteria:\` as a mapping of ≥ 2 option ids → descriptions`,
        );
      }
      const opts: Record<string, JudgeJson> = {};
      for (const [opt, desc] of Object.entries(criteria)) {
        if (!isJudgeIdentifier(opt)) {
          throw new JudgeParseError(
            `choice question "${id}" option "${opt}" is not a valid identifier (it becomes an output field and, when routed, a route name)`,
          );
        }
        opts[opt] = asJson(desc, `question "${id}".criteria.${opt}`);
      }
      out[id] = { type: "choice", instructions, criteria: opts };
    } else if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2) {
        throw new JudgeParseError(
          `score question "${id}" needs \`criteria:\` as an ordered list of ≥ 2 level descriptions (lowest first)`,
        );
      }
      out[id] = {
        type: "score",
        instructions,
        criteria: criteria.map((c, i) => asJson(c, `question "${id}".criteria[${i}]`)),
      };
    } else {
      if (criteria === undefined) {
        out[id] = { type: "noul", instructions };
      } else {
        if (!isPlainObject(criteria) || Object.keys(criteria).some((k) => k !== "true" && k !== "false")) {
          throw new JudgeParseError(`noul question "${id}" \`criteria:\` may only have \`true:\` / \`false:\` keys`);
        }
        const c: Record<string, JudgeJson> = {};
        for (const [k, v] of Object.entries(criteria)) c[k] = asJson(v, `question "${id}".criteria.${k}`);
        out[id] = { type: "noul", instructions, criteria: c };
      }
    }
  }
  return out;
}

export function parseJudgeState(raw: unknown, path = "state"): JudgeState {
  if (typeof raw === "string") {
    if (raw.trim().length === 0) throw new JudgeParseError(`\`${path}\` is empty`);
    return raw;
  }
  if (!isPlainObject(raw)) {
    throw new JudgeParseError(`\`${path}\` must be text, a \`{file: <path>}\` leaf, or a mapping of those`);
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new JudgeParseError(`\`${path}\` is an empty mapping`);
  if (keys.length === 1 && keys[0] === "file") {
    const file = raw["file"];
    if (typeof file !== "string" || file.trim().length === 0) {
      throw new JudgeParseError(`\`${path}.file\` must be a non-empty cwd-relative path`);
    }
    if (file.startsWith("/") || file.split(/[\\/]/).includes("..")) {
      throw new JudgeParseError(
        `\`${path}.file\` must be relative to the worktree and may not contain \`..\` (got ${JSON.stringify(file)})`,
      );
    }
    return { file };
  }
  const out: { [k: string]: JudgeState } = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parseJudgeState(v, `${path}.${k}`);
  return out;
}

function unitInterval(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new JudgeParseError(`\`${path}\` must be a number in [0, 1]`);
  }
  return v;
}

function questionRef(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) throw new JudgeParseError(`\`${path}\` must name a question`);
  return v;
}

export function parseJudgeDecide(raw: unknown): JudgeDecide {
  if (!isPlainObject(raw))
    throw new JudgeParseError("`decide:` must be a mapping with exactly one of `route:` / `outcome:`");
  const keys = Object.keys(raw);
  if (keys.length !== 1 || (keys[0] !== "route" && keys[0] !== "outcome")) {
    throw new JudgeParseError("`decide:` must have exactly one of `route:` / `outcome:`");
  }
  if (keys[0] === "route") {
    const r = raw["route"];
    if (!isPlainObject(r))
      throw new JudgeParseError("`decide.route` must be a mapping {question, min-confidence?, below?}");
    for (const k of Object.keys(r)) {
      if (k !== "question" && k !== "min-confidence" && k !== "below") {
        throw new JudgeParseError(
          `\`decide.route\` has unknown key "${k}" (expected question / min-confidence / below)`,
        );
      }
    }
    const question = questionRef(r["question"], "decide.route.question");
    const minC = r["min-confidence"];
    const below = r["below"];
    if ((minC === undefined) !== (below === undefined)) {
      throw new JudgeParseError("`decide.route` needs both `min-confidence` and `below` or neither");
    }
    if (minC === undefined) return { route: { question } };
    if (typeof below !== "string" || below.length === 0) {
      throw new JudgeParseError("`decide.route.below` must name a route declared in `routes:`");
    }
    return { route: { question, min_confidence: unitInterval(minC, "decide.route.min-confidence"), below } };
  }
  const o = raw["outcome"];
  if (!isPlainObject(o)) throw new JudgeParseError("`decide.outcome` must be a mapping {question, min}");
  for (const k of Object.keys(o)) {
    if (k !== "question" && k !== "min") {
      throw new JudgeParseError(`\`decide.outcome\` has unknown key "${k}" (expected question / min)`);
    }
  }
  return {
    outcome: {
      question: questionRef(o["question"], "decide.outcome.question"),
      min: unitInterval(o["min"], "decide.outcome.min"),
    },
  };
}

export function parseJudgeStateMaxBytes(raw: unknown): number {
  if (raw === undefined) return JUDGE_DEFAULT_STATE_MAX_BYTES;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > JUDGE_HARD_STATE_MAX_BYTES) {
    throw new JudgeParseError(`\`state-max-bytes\` must be a positive integer ≤ ${JUDGE_HARD_STATE_MAX_BYTES}`);
  }
  return raw;
}
