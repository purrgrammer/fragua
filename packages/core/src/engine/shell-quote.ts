// Shell escaping for `${{ … }}` values substituted into a `tool` `run:` string.
// A value has to be escaped for the quoting state the token sits in: a
// single-quote wrap is inert in bare context, but inside `"…"` the quotes are
// literal and `$(…)` still expands, and inside `'…'` the wrap closes the
// author's quote. The scanner tracks POSIX quote state (backslash, `'`, `"`)
// plus the nested constructs that reset or defeat it, and reports the context
// of every token so the caller can pick the escape — or refuse a position no
// escape can make inert. A literal `$` glued to a token is one such position:
// it fuses with the escaped value into `$(…)`, `$'…'` or `$name`. A token in a
// heredoc delimiter is another: its escaping decides whether the body expands
// and where the body ends. A token the scan never places fails closed too.

export type ShellQuoteContext = "bare" | "double" | "single";

/** Positions where no escaping of the inserted text keeps it inert. */
export type UnsafeShellPosition =
  | "escaped"
  | "backtick"
  | "comment"
  | "heredoc"
  | "ansi-c"
  | "arithmetic"
  | "dollar-prefix"
  | "heredoc-delimiter"
  | "unplaced";

export type ShellTokenContext = ShellQuoteContext | { unsafe: UnsafeShellPosition };

export const UNSAFE_SHELL_POSITIONS: Readonly<Record<UnsafeShellPosition, { where: string; fix: string }>> = {
  escaped: { where: "after a backslash", fix: "remove the backslash" },
  backtick: { where: "inside backticks", fix: "use `$(…)` instead of backticks" },
  comment: { where: "inside a `#` comment", fix: "drop the reference from the comment" },
  heredoc: {
    where: "inside a heredoc body",
    fix: 'bind it to a variable first (`v=${{ … }}`) and use `"$v"` in the heredoc',
  },
  "ansi-c": { where: "inside `$'…'`", fix: "use double quotes" },
  arithmetic: {
    where: "inside `$((…))`",
    fix: 'bind it to a variable first (`v=${{ … }}`) and validate it before using `"$v"` in arithmetic',
  },
  "dollar-prefix": {
    where: "directly after a literal `$`",
    fix: "remove the `$` or bind the value to a variable first",
  },
  "heredoc-delimiter": {
    where: "in a heredoc delimiter word",
    fix: "use a literal delimiter word and bind the value to a variable used inside the body",
  },
  unplaced: {
    where: "where the shell scan cannot place it",
    fix: "move it into a bare or double-quoted word",
  },
};

/** The context of the token at `offset`; a token the scan left unplaced is
 * unsafe rather than defaulting to bare. */
export function shellContextAt(contexts: ReadonlyMap<number, ShellTokenContext>, offset: number): ShellTokenContext {
  return contexts.get(offset) ?? { unsafe: "unplaced" };
}

export function shellEscapeForContext(value: string, ctx: ShellQuoteContext): string {
  switch (ctx) {
    case "bare":
      return `'${value.replace(/'/g, "'\\''")}'`;
    case "double":
      return value.replace(/[\\$`"]/g, "\\$&");
    case "single":
      return value.replace(/'/g, "'\\''");
  }
}

export interface UnsafeShellRef {
  /** The reference as written, e.g. `${{ inputs.x }}`. */
  readonly ref: string;
  readonly position: UnsafeShellPosition;
}

/** Thrown by shell-escaping substitution when a token sits where no escape
 * keeps its value inert. The tool handler turns it into a node failure. */
export class ShellContextError extends Error {
  readonly refs: readonly UnsafeShellRef[];
  constructor(all: UnsafeShellRef[]) {
    const refs = [...new Map(all.map((r) => [`${r.ref}|${r.position}`, r])).values()];
    const detail = refs.map(({ ref, position }) => `${ref} (${UNSAFE_SHELL_POSITIONS[position].where})`).join(", ");
    super(
      `substituted value${refs.length > 1 ? "s" : ""} in an unsafe shell position: ${detail} — no escaping keeps a value inert there`,
    );
    this.name = "ShellContextError";
    this.refs = refs;
  }
}

type Frame =
  | { kind: "cmd"; depth: number; sub: boolean }
  | { kind: "arith"; depth: number }
  | { kind: "double" }
  | { kind: "single" }
  | { kind: "backtick" }
  | { kind: "ansi" }
  | { kind: "comment" };

interface PendingHeredoc {
  delim: string;
  stripTabs: boolean;
}

const WORD_BREAK = /[\s;&|()<>]/;

function contextOf(frame: Frame): ShellTokenContext {
  switch (frame.kind) {
    case "cmd":
      return "bare";
    case "double":
      return "double";
    case "single":
      return "single";
    case "backtick":
      return { unsafe: "backtick" };
    case "ansi":
      return { unsafe: "ansi-c" };
    case "comment":
      return { unsafe: "comment" };
    case "arith":
      return { unsafe: "arithmetic" };
  }
}

/** The quoting context of every `tokenRe` match in `template`, keyed by the
 * match offset. Each match is consumed as one opaque word, so its text never
 * moves the quote state. */
export function scanShellTokenContexts(template: string, tokenRe: RegExp): Map<number, ShellTokenContext> {
  const flags = tokenRe.flags.includes("g") ? tokenRe.flags : `${tokenRe.flags}g`;
  const tokens = new Map<number, number>();
  for (const m of template.matchAll(new RegExp(tokenRe.source, flags))) tokens.set(m.index, m.index + m[0].length);

  const out = new Map<number, ShellTokenContext>();
  const root: Frame = { kind: "cmd", depth: 0, sub: false };
  const stack: Frame[] = [root];
  const pending: PendingHeredoc[] = [];
  const at = (k: number): string => template[k] ?? "";
  const startsWith = (k: number, s: string): boolean => template.startsWith(s, k);

  const consumeHeredocs = (start: number): number => {
    let pos = start;
    for (const doc of pending) {
      while (pos < template.length) {
        const nl = template.indexOf("\n", pos);
        let lineEnd = nl === -1 ? template.length : nl;
        const line = template.slice(pos, lineEnd);
        if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delim) {
          for (let k = pos; k < lineEnd; k++) if (tokens.has(k)) out.set(k, { unsafe: "heredoc-delimiter" });
          pos = lineEnd + 1;
          break;
        }
        for (let k = pos; k < lineEnd; k++) {
          const end = tokens.get(k);
          if (end === undefined) continue;
          out.set(k, { unsafe: "heredoc" });
          if (end > lineEnd) {
            const next = template.indexOf("\n", end);
            lineEnd = next === -1 ? template.length : next;
          }
        }
        pos = lineEnd + 1;
      }
    }
    pending.length = 0;
    return pos;
  };

  const readHeredocOperator = (start: number): number => {
    let k = start + 2;
    const stripTabs = at(k) === "-";
    if (stripTabs) k++;
    while (at(k) === " " || at(k) === "\t") k++;
    const wordStart = k;
    while (k < template.length && !WORD_BREAK.test(at(k))) {
      const end = tokens.get(k);
      if (end !== undefined) out.set(k, { unsafe: "heredoc-delimiter" });
      k = end ?? k + 1;
    }
    const delim = template.slice(wordStart, k).replace(/['"\\]/g, "");
    if (delim.length > 0) pending.push({ delim, stripTabs });
    return k;
  };

  let escapedAt = -1;
  let i = 0;
  while (i < template.length) {
    const top = stack[stack.length - 1] ?? root;
    const tokenEnd = tokens.get(i);
    if (tokenEnd !== undefined) {
      out.set(i, at(i - 1) === "$" && escapedAt !== i - 1 ? { unsafe: "dollar-prefix" } : contextOf(top));
      i = tokenEnd;
      continue;
    }
    const c = at(i);

    if (c === "\\" && top.kind !== "single" && top.kind !== "comment") {
      const escapedEnd = tokens.get(i + 1);
      if (escapedEnd !== undefined) {
        out.set(i + 1, { unsafe: "escaped" });
        i = escapedEnd;
      } else {
        escapedAt = i + 1;
        i += 2;
      }
      continue;
    }

    switch (top.kind) {
      case "single":
        if (c === "'") stack.pop();
        i++;
        break;
      case "ansi":
        if (c === "'") stack.pop();
        i++;
        break;
      case "backtick":
        if (c === "`") stack.pop();
        i++;
        break;
      case "comment":
        if (c === "\n") stack.pop();
        else i++;
        break;
      case "double":
        if (c === '"') {
          stack.pop();
          i++;
        } else if (c === "`") {
          stack.push({ kind: "backtick" });
          i++;
        } else if (startsWith(i, "$((")) {
          stack.push({ kind: "arith", depth: 0 });
          i += 3;
        } else if (startsWith(i, "$(")) {
          stack.push({ kind: "cmd", depth: 0, sub: true });
          i += 2;
        } else {
          i++;
        }
        break;
      case "arith":
        if (startsWith(i, "$((")) {
          stack.push({ kind: "arith", depth: 0 });
          i += 3;
        } else if (startsWith(i, "$(")) {
          stack.push({ kind: "cmd", depth: 0, sub: true });
          i += 2;
        } else if (c === "(") {
          top.depth++;
          i++;
        } else if (c === ")") {
          if (top.depth === 0 && at(i + 1) === ")") {
            stack.pop();
            i += 2;
          } else {
            top.depth = Math.max(0, top.depth - 1);
            i++;
          }
        } else if (c === '"') {
          stack.push({ kind: "double" });
          i++;
        } else if (c === "`") {
          stack.push({ kind: "backtick" });
          i++;
        } else {
          i++;
        }
        break;
      case "cmd":
        if (c === "'") {
          stack.push({ kind: "single" });
          i++;
        } else if (c === '"') {
          stack.push({ kind: "double" });
          i++;
        } else if (c === "`") {
          stack.push({ kind: "backtick" });
          i++;
        } else if (startsWith(i, "$'")) {
          stack.push({ kind: "ansi" });
          i += 2;
        } else if (startsWith(i, "$((")) {
          stack.push({ kind: "arith", depth: 0 });
          i += 3;
        } else if (startsWith(i, "$(")) {
          stack.push({ kind: "cmd", depth: 0, sub: true });
          i += 2;
        } else if (c === "(") {
          top.depth++;
          i++;
        } else if (c === ")") {
          if (top.depth > 0) top.depth--;
          else if (top.sub) stack.pop();
          i++;
        } else if (c === "#" && (i === 0 || WORD_BREAK.test(at(i - 1)))) {
          stack.push({ kind: "comment" });
          i++;
        } else if (startsWith(i, "<<<")) {
          i += 3;
        } else if (startsWith(i, "<<")) {
          i = readHeredocOperator(i);
        } else if (c === "\n") {
          i++;
          if (pending.length > 0) i = consumeHeredocs(i);
        } else {
          i++;
        }
        break;
    }
  }
  for (const k of tokens.keys()) if (!out.has(k)) out.set(k, { unsafe: "unplaced" });
  return out;
}
