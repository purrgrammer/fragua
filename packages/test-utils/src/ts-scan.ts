// Syntax-only TypeScript-AST scanning for the discipline lints. Parses a file
// with the compiler API (no type-checker Program) and exposes the walks the
// lints need: call expressions inside a callback body (with one level of
// same-file helper inlining), element access / destructuring on a named binding,
// import / dynamic-import / require declarations, and a transitive relative
// import walk from an entry file. A regex source scan can be defeated by
// renaming or by routing the forbidden call through a helper; these walks can't.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

/** Parse a `.ts`/`.tsx` file into a SourceFile with parent pointers set. */
export function parseSource(path: string): ts.SourceFile {
  const text = readFileSync(path, "utf8");
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/** 1-based line number of a node's start. */
export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** True when `marker` appears in a line-comment on the node's line or the line
 * directly above it (the escape-hatch convention shared by every lint). */
export function allowMarked(sf: ts.SourceFile, node: ts.Node, marker: string): boolean {
  const lines = sf.text.split("\n");
  const line = lineOf(sf, node);
  const inComment = (s: string | undefined): boolean => {
    if (s === undefined) return false;
    const i = s.indexOf("//");
    return i >= 0 && s.slice(i).includes(marker);
  };
  const prev = lines[line - 2];
  const prevIsComment = prev?.trimStart().startsWith("//") === true;
  return inComment(lines[line - 1]) || (prevIsComment && inComment(prev));
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

/** Depth-first walk. When `skipNested` is set, descent stops at nested
 * function-like nodes (their bodies are deferred, not run synchronously). */
export function walk(root: ts.Node, visit: (n: ts.Node) => void, skipNested = false): void {
  const rec = (n: ts.Node): void => {
    visit(n);
    ts.forEachChild(n, (c) => {
      if (skipNested && isFunctionLike(c)) return;
      rec(c);
    });
  };
  rec(root);
}

/** The tail identifier of a callee: `f` for `f(...)`, `m` for `a.b.m(...)`. */
function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

export interface CallInfo {
  /** Tail identifier of the callee. */
  name: string;
  /** Full source text of the callee expression (e.g. `JSON.stringify`). */
  text: string;
  node: ts.CallExpression;
}

/** All call expressions under `root`. `skipNested` excludes calls inside nested
 * deferred functions (used for transaction bodies). */
export function collectCalls(root: ts.Node, sf: ts.SourceFile, skipNested = false): CallInfo[] {
  const out: CallInfo[] = [];
  walk(
    root,
    (n) => {
      if (ts.isCallExpression(n)) {
        out.push({ name: calleeName(n.expression) ?? "", text: n.expression.getText(sf), node: n });
      }
    },
    skipNested,
  );
  return out;
}

/** `await` expressions under `root`, excluding nested deferred functions. */
export function collectAwaits(root: ts.Node): ts.AwaitExpression[] {
  const out: ts.AwaitExpression[] = [];
  walk(
    root,
    (n) => {
      if (ts.isAwaitExpression(n)) out.push(n);
    },
    true,
  );
  return out;
}

/** Body node of every call to one of `calleeNames` whose first argument is an
 * arrow / function expression — e.g. `writeTxn(() => { ... })`. */
export function callbackBodiesOf(sf: ts.SourceFile, calleeNames: readonly string[]): ts.Node[] {
  const names = new Set(calleeNames);
  const out: ts.Node[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n.expression);
    if (name === undefined || !names.has(name)) return;
    const arg = n.arguments[0];
    if (arg !== undefined && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) out.push(arg.body);
  });
  return out;
}

/** Map of same-file function/method/arrow-const name → its body node, for one
 * level of helper inlining when scanning a callback. */
export function sameFileFunctionBodies(sf: ts.SourceFile): Map<string, ts.Node> {
  const map = new Map<string, ts.Node>();
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined && n.body !== undefined) map.set(n.name.text, n.body);
    else if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.body !== undefined) map.set(n.name.text, n.body);
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer !== undefined &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      map.set(n.name.text, n.initializer.body);
    }
  });
  return map;
}

/** Object expression a member/element access hangs off: its tail identifier. */
function accessObjectName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

export interface ElementAccessInfo {
  objectText: string;
  objectName: string | undefined;
  node: ts.ElementAccessExpression;
}

/** Every `x[...]` element access in the file. */
export function collectElementAccess(sf: ts.SourceFile): ElementAccessInfo[] {
  const out: ElementAccessInfo[] = [];
  walk(sf, (n) => {
    if (ts.isElementAccessExpression(n)) {
      out.push({ objectText: n.expression.getText(sf), objectName: accessObjectName(n.expression), node: n });
    }
  });
  return out;
}

export interface DestructuringInfo {
  initText: string;
  initName: string | undefined;
  node: ts.VariableDeclaration;
}

/** Object-pattern destructurings with an identifier / property-access initializer
 * (`const { a } = someRouting`). */
export function collectDestructurings(sf: ts.SourceFile): DestructuringInfo[] {
  const out: DestructuringInfo[] = [];
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isObjectBindingPattern(n.name) || n.initializer === undefined) return;
    const init = n.initializer;
    if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
      out.push({ initText: init.getText(sf), initName: accessObjectName(init), node: n });
    }
  });
  return out;
}

/** Names of variables / parameters annotated with a type reference to `typeName`. */
export function typedBindings(sf: ts.SourceFile, typeName: string): Set<string> {
  const out = new Set<string>();
  const named = (t: ts.TypeNode | undefined): boolean =>
    t !== undefined && ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === typeName;
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && named(n.type)) out.add(n.name.text);
    else if (ts.isParameter(n) && ts.isIdentifier(n.name) && named(n.type)) out.add(n.name.text);
  });
  return out;
}

export interface ImportInfo {
  module: string;
  kind: "static" | "dynamic" | "require";
  typeOnly: boolean;
  node: ts.Node;
}

/** All module references: static `import`/`export … from`, dynamic `import()`
 * calls, and `require()` calls. Type-position `import("x").Y` (an ImportTypeNode,
 * not a call) is naturally excluded — it carries no runtime import. */
export function collectImports(sf: ts.SourceFile): ImportInfo[] {
  const out: ImportInfo[] = [];
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({
        module: n.moduleSpecifier.text,
        kind: "static",
        typeOnly: n.importClause?.isTypeOnly ?? false,
        node: n,
      });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ module: n.moduleSpecifier.text, kind: "static", typeOnly: n.isTypeOnly, node: n });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg))
        out.push({ module: arg.text, kind: "dynamic", typeOnly: false, node: n });
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") {
      const arg = n.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg))
        out.push({ module: arg.text, kind: "require", typeOnly: false, node: n });
    }
  });
  return out;
}

export interface ImportBinding {
  /** Module specifier the symbol comes from. */
  module: string;
  /** Original exported name (`existsSync` for `import { existsSync as e }`);
   * `"default"` for a default import, `"*"` for a namespace import. */
  imported: string;
}

/** Local binding name → its origin, for every value `import` in the file, so an
 * aliased `import { existsSync as e }` can be matched against the imported symbol
 * rather than the local name. Type-only imports carry no runtime binding and are
 * skipped. */
export function importBindings(sf: ts.SourceFile): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  walk(sf, (n) => {
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return;
    const clause = n.importClause;
    if (clause === undefined || clause.isTypeOnly) return;
    const module = n.moduleSpecifier.text;
    if (clause.name !== undefined) out.set(clause.name.text, { module, imported: "default" });
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      out.set(bindings.name.text, { module, imported: "*" });
    } else {
      for (const spec of bindings.elements) {
        if (spec.isTypeOnly) continue;
        out.set(spec.name.text, { module, imported: (spec.propertyName ?? spec.name).text });
      }
    }
  });
  return out;
}

/** Alias name → its underlying type node, for every `type X = …` in the file, so
 * a bare `: X` annotation can be resolved to what `X` actually stands for. */
export function resolveTypeAliases(sf: ts.SourceFile): Map<string, ts.TypeNode> {
  const out = new Map<string, ts.TypeNode>();
  walk(sf, (n) => {
    if (ts.isTypeAliasDeclaration(n)) out.set(n.name.text, n.type);
  });
  return out;
}

/** Resolve a called symbol to the body of the same-named function it is imported
 * from over a RELATIVE import, so a lint scanning a call site can follow into the
 * imported module. Returns the imported module's SourceFile alongside the body so
 * the caller can keep following same-file helpers there. */
export function resolveImportedFunctionBody(
  sf: ts.SourceFile,
  fromDir: string,
  name: string,
): { sf: ts.SourceFile; body: ts.Node } | undefined {
  const binding = importBindings(sf).get(name);
  if (binding === undefined || !binding.module.startsWith(".")) return undefined;
  const resolved = resolveModule(fromDir, binding.module);
  if (resolved === undefined) return undefined;
  const moduleSf = parseSource(resolved);
  const body = sameFileFunctionBodies(moduleSf).get(binding.imported);
  return body === undefined ? undefined : { sf: moduleSf, body };
}

export interface MemberAccessInfo {
  objectName: string | undefined;
  name: string;
  node: ts.PropertyAccessExpression;
}

/** Every `a.b` property access (used to spot `Bun.*` / `process.env`). */
export function collectMemberAccess(sf: ts.SourceFile): MemberAccessInfo[] {
  const out: MemberAccessInfo[] = [];
  walk(sf, (n) => {
    if (ts.isPropertyAccessExpression(n)) {
      out.push({
        objectName: ts.isIdentifier(n.expression) ? n.expression.text : undefined,
        name: n.name.text,
        node: n,
      });
    }
  });
  return out;
}

function resolveModule(fromDir: string, spec: string): string | undefined {
  const base = resolve(fromDir, spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
  return candidates.find((c) => existsSync(c) && !c.endsWith("/"));
}

/** Set of absolute file paths reachable from `entry` over RELATIVE value imports
 * / re-exports (type-only imports carry no runtime code and are not followed). */
export function transitiveRelativeImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const imp of collectImports(parseSource(file))) {
      if (imp.typeOnly || !imp.module.startsWith(".")) continue;
      const resolved = resolveModule(dirname(file), imp.module);
      if (resolved !== undefined) queue.push(resolved);
    }
  }
  return seen;
}
