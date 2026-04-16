// Hand-written tokenizer for the DOT subset swarm supports.
// See docs/SPEC.md §3.1 for the grammar.

export type TokenType =
  | "IDENT"
  | "STRING"
  | "NUMBER"
  | "EQUALS"
  | "COMMA"
  | "SEMI"
  | "LBRACE"
  | "RBRACE"
  | "LBRACKET"
  | "RBRACKET"
  | "ARROW"
  | "KEYWORD"
  | "EOF";

export type Keyword = "digraph" | "subgraph" | "graph" | "node" | "edge" | "strict";

const KEYWORDS: ReadonlySet<Keyword> = new Set(["digraph", "subgraph", "graph", "node", "edge", "strict"]);

export interface Token {
  type: TokenType;
  value: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
  /** 0-based absolute offset. */
  offset: number;
}

export class LexError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(`${message} at line ${line}, col ${col}`);
    this.name = "LexError";
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const col = () => i - lineStart + 1;

  const push = (type: TokenType, value: string, startOffset: number, startLine: number, startCol: number): void => {
    tokens.push({ type, value, line: startLine, col: startCol, offset: startOffset });
  };

  while (i < source.length) {
    const ch = source[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }

    // Line comment: //...\n
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    // Block comment: /* ... */
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (i >= source.length) throw new LexError("unterminated block comment", line, col());
      i += 2;
      continue;
    }
    // Hash comment (DOT extension): # to EOL
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    const tokLine = line;
    const tokCol = col();
    const tokOffset = i;

    // Arrow
    if (ch === "-" && source[i + 1] === ">") {
      push("ARROW", "->", tokOffset, tokLine, tokCol);
      i += 2;
      continue;
    }

    // Single-char punctuation
    if (ch === "{") {
      push("LBRACE", "{", tokOffset, tokLine, tokCol);
      i++;
      continue;
    }
    if (ch === "}") {
      push("RBRACE", "}", tokOffset, tokLine, tokCol);
      i++;
      continue;
    }
    if (ch === "[") {
      push("LBRACKET", "[", tokOffset, tokLine, tokCol);
      i++;
      continue;
    }
    if (ch === "]") {
      push("RBRACKET", "]", tokOffset, tokLine, tokCol);
      i++;
      continue;
    }
    if (ch === ",") {
      push("COMMA", ",", tokOffset, tokLine, tokCol);
      i++;
      continue;
    }
    if (ch === ";") {
      push("SEMI", ";", tokOffset, tokLine, tokCol);
      i++;
      continue;
    }
    if (ch === "=") {
      push("EQUALS", "=", tokOffset, tokLine, tokCol);
      i++;
      continue;
    }

    // Quoted string with \" escapes. DOT also supports "..." + "..." concatenation,
    // which we handle here for spec-compliance.
    if (ch === '"') {
      const parts: string[] = [];
      while (i < source.length && source[i] === '"') {
        i++; // opening quote
        let buf = "";
        while (i < source.length && source[i] !== '"') {
          if (source[i] === "\\" && i + 1 < source.length) {
            const next = source[i + 1] as string;
            if (next === '"' || next === "\\") {
              buf += next;
              i += 2;
              continue;
            }
            if (next === "n") {
              buf += "\n";
              i += 2;
              continue;
            }
            if (next === "t") {
              buf += "\t";
              i += 2;
              continue;
            }
            if (next === "r") {
              buf += "\r";
              i += 2;
              continue;
            }
            // unknown escape — keep backslash literal
            buf += source[i];
            i++;
            continue;
          }
          if (source[i] === "\n") {
            line++;
            lineStart = i + 1;
          }
          buf += source[i];
          i++;
        }
        if (i >= source.length) throw new LexError("unterminated string", tokLine, tokCol);
        i++; // closing quote
        parts.push(buf);

        // Peek for continuation across whitespace
        let j = i;
        while (j < source.length && (source[j] === " " || source[j] === "\t" || source[j] === "\n")) {
          if (source[j] === "\n") {
            // advance our line tracking cautiously: only finalize if we actually consume
          }
          j++;
        }
        if (source[j] === "+") {
          // consume whitespace + '+' + whitespace, continue concatenation
          while (i < j) {
            if (source[i] === "\n") {
              line++;
              lineStart = i + 1;
            }
            i++;
          }
          i++; // '+'
          while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\n")) {
            if (source[i] === "\n") {
              line++;
              lineStart = i + 1;
            }
            i++;
          }
          continue;
        }
        break;
      }
      push("STRING", parts.join(""), tokOffset, tokLine, tokCol);
      continue;
    }

    // Number: optional minus, digits, optional fraction
    if (ch !== undefined && (ch === "-" || (ch >= "0" && ch <= "9") || ch === ".")) {
      let j = i;
      if (source[j] === "-") j++;
      let sawDigit = false;
      while (j < source.length) {
        const c = source[j];
        if (c === undefined || c < "0" || c > "9") break;
        sawDigit = true;
        j++;
      }
      if (source[j] === ".") {
        j++;
        while (j < source.length) {
          const c = source[j];
          if (c === undefined || c < "0" || c > "9") break;
          sawDigit = true;
          j++;
        }
      }
      if (sawDigit) {
        const raw = source.slice(i, j);
        push("NUMBER", raw, tokOffset, tokLine, tokCol);
        i = j;
        continue;
      }
    }

    // Identifier: [A-Za-z_][A-Za-z0-9_]*
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < source.length && isIdentPart(source[j])) j++;
      const ident = source.slice(i, j);
      if (KEYWORDS.has(ident as Keyword)) {
        push("KEYWORD", ident, tokOffset, tokLine, tokCol);
      } else {
        push("IDENT", ident, tokOffset, tokLine, tokCol);
      }
      i = j;
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(ch)}`, tokLine, tokCol);
  }

  tokens.push({ type: "EOF", value: "", line, col: col(), offset: i });
  return tokens;
}

function isIdentStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}
