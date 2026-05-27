// Aho-Corasick automaton + compiled pattern set for secret scrubbing.
// Pure, deterministic — no I/O, no clock, no random.

export interface CompiledPattern {
  source: string;
  re: RegExp;
}

export interface CompiledRegistry {
  /** Aho-Corasick automaton for literal (and encoding-expanded) needles. */
  readonly ac: AhoCorasick;
  /** Pre-compiled regex patterns (NOT encoding-expanded). */
  readonly patterns: readonly CompiledPattern[];
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function toBase64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function toPercent(s: string): string {
  return encodeURIComponent(s);
}

// ---------------------------------------------------------------------------
// Source-label precedence (shared with scrub.ts)
// ---------------------------------------------------------------------------

export function sourcePrecedence(source: string): number {
  if (source === "provider_creds") return 0;
  if (source.startsWith("env:")) return 1;
  return 2;
}

/** Pick the most-specific source; ties broken lexically for determinism. */
export function mergeSourcePrecedence(a: string, b: string): string {
  const pa = sourcePrecedence(a);
  const pb = sourcePrecedence(b);
  if (pa < pb) return a;
  if (pb < pa) return b;
  return a <= b ? a : b;
}

// ---------------------------------------------------------------------------
// Aho-Corasick automaton
// ---------------------------------------------------------------------------

// State is an index. Edges are stored SPARSELY — one Map<charCode, state> per
// state — so memory is O(Σ needle lengths), not O(states × alphabet). The DFA
// is NOT pre-completed; search follows failure links on a missing edge.
// goto: state → (char-code → next state); absent key = no edge
// fail: state → fall-back state on mismatch
// out:  state → list of (needle-length, source-label) output records

interface AcOutput {
  len: number;
  source: string;
}

export class AhoCorasick {
  private readonly goto: Map<number, number>[]; // goto[state].get(charCode) = nextState
  private readonly fail: Int32Array; // fail[state] = failState
  private readonly out: AcOutput[][]; // out[state] = [{len, source}, ...]
  constructor(goto: Map<number, number>[], fail: Int32Array, out: AcOutput[][]) {
    this.goto = goto;
    this.fail = fail;
    this.out = out;
  }

  /**
   * Scan `text` and return every match as {start, end (exclusive), source}.
   * Multiple overlapping or adjacent hits are returned; callers must merge.
   */
  search(text: string): { start: number; end: number; source: string }[] {
    const results: { start: number; end: number; source: string }[] = [];
    let state = 0;
    const n = text.length;

    for (let i = 0; i < n; i++) {
      const ch = text.charCodeAt(i);

      // Follow failure links until an existing goto edge or the root.
      while (state !== 0 && !this.goto[state]!.has(ch)) {
        state = this.fail[state]!;
      }
      // Root with no edge for `ch` stays at 0.
      state = this.goto[state]!.get(ch) ?? 0;

      // Emit all outputs at this state.
      for (const o of this.out[state]!) {
        results.push({ start: i - o.len + 1, end: i + 1, source: o.source });
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Automaton builder
// ---------------------------------------------------------------------------

interface Needle {
  text: string;
  source: string;
}

function buildAhoCorasick(needles: Needle[]): AhoCorasick {
  // Deduplicate: same text with multiple sources → keep highest-precedence
  // source (provider_creds > env:* > pattern:* > other), then lexical for ties.
  // Deterministic: stable regardless of Map iteration order.
  const bestSource = new Map<string, string>();
  for (const n of needles) {
    const existing = bestSource.get(n.text);
    if (existing === undefined) {
      bestSource.set(n.text, n.source);
    } else {
      bestSource.set(n.text, mergeSourcePrecedence(existing, n.source));
    }
  }
  // Reconstruct unique list in stable insertion order (first occurrence of each text).
  const seen = new Set<string>();
  const unique: Needle[] = [];
  for (const n of needles) {
    if (!seen.has(n.text)) {
      seen.add(n.text);
      unique.push({ text: n.text, source: bestSource.get(n.text)! });
    }
  }

  // Sparse trie: one Map<charCode, state> per state. State 0 is the root.
  const gotoArr: Map<number, number>[] = [new Map()];
  const outArr: AcOutput[][] = [[]];

  function newState(): number {
    const idx = gotoArr.length;
    gotoArr.push(new Map());
    outArr.push([]);
    return idx;
  }

  // Phase 1: insert all needles into the trie.
  for (const needle of unique) {
    let state = 0;
    for (let ci = 0; ci < needle.text.length; ci++) {
      const ch = needle.text.charCodeAt(ci);
      let nxt = gotoArr[state]!.get(ch);
      if (nxt === undefined) {
        nxt = newState();
        gotoArr[state]!.set(ch, nxt);
      }
      state = nxt;
    }
    outArr[state]!.push({ len: needle.text.length, source: needle.source });
  }

  // Phase 2: BFS over the sparse edges to build failure links + propagate
  // output sets. We do NOT complete the goto function; search follows fail
  // links. Iteration order over each Map is insertion order — deterministic.
  const fail = new Int32Array(gotoArr.length); // all 0 (→ root)
  const queue: number[] = [];
  for (const s of gotoArr[0]!.values()) queue.push(s); // depth-1: fail → root

  let qi = 0;
  while (qi < queue.length) {
    const r = queue[qi++]!;
    for (const [ch, s] of gotoArr[r]!) {
      queue.push(s);
      // fail[s]: deepest state on r's fail chain that has a `ch` edge, else root.
      let f = fail[r]!;
      while (f !== 0 && !gotoArr[f]!.has(ch)) {
        f = fail[f]!;
      }
      const cand = gotoArr[f]!.get(ch);
      fail[s] = cand !== undefined && cand !== s ? cand : 0;
      // Merge output sets: out[s] ∪= out[fail[s]].
      const fs = fail[s]!;
      if (outArr[fs]!.length > 0) {
        outArr[s] = outArr[s]!.concat(outArr[fs]!);
      }
    }
  }

  return new AhoCorasick(gotoArr, fail, outArr);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const WHITESPACE_RE = /\s/;
const MIN_LITERAL_LEN = 8;

export function compileRegistry(input: {
  literals: Array<{ value: string; source: string }>;
  patterns: Array<{ source: string; re: RegExp }>;
}): CompiledRegistry {
  const needles: Needle[] = [];

  for (const { value, source } of input.literals) {
    // VALUE-LENGTH FLOOR: drop short or whitespace-containing literals.
    if (value.length < MIN_LITERAL_LEN || WHITESPACE_RE.test(value)) continue;

    // ENCODING-EXPAND: add verbatim + three encoded forms.
    const forms = [value, toBase64(value), toBase64Url(value), toPercent(value)];

    for (const form of forms) {
      if (form.length > 0) {
        needles.push({ text: form, source });
      }
    }
  }

  const ac = buildAhoCorasick(needles);

  const patterns: CompiledPattern[] = input.patterns.map((p) => ({
    source: p.source,
    re: new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`),
  }));

  return { ac, patterns };
}
