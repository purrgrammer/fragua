// Syntax-only TypeScript-AST scanning for the discipline lints. Parses a file
// with the compiler API (no type-checker Program) and exposes the walks the
// lints need: call expressions inside a callback body (inline, or passed by
// name and resolved to its local declaration), element access / destructuring
// on a named binding, import / dynamic-import / require declarations (literal
// or computed specifiers), and a transitive relative import walk from an entry
// file. A regex source scan can be defeated by
// renaming or by routing the forbidden call through a helper; these walks can't.
//
// `normalizeCallee` is the one place callee shapes are canonicalised for every
// lint: global-object receivers (`globalThis.JSON` is `JSON` unless a local
// binding shadows the receiver), literal-key element access, local `const` /
// `let` aliases and destructurings (`const J = JSON`, `const { stringify } =
// JSON`), and a trailing `.call` / `.apply` / `.bind` forwarder.

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

/** Key of an element access whose argument is a string or no-substitution
 * template literal (`x["k"]`, ``x[`k`]``) — the property it names, exactly as
 * `x.k` would. Undefined for a computed key. */
export function literalKey(expr: ts.ElementAccessExpression): string | undefined {
  const arg = expr.argumentExpression;
  return ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/** The tail identifier of a callee: `f` for `f(...)`, `m` for `a.b.m(...)` and
 * for `a.b["m"](...)`. */
function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr)) return literalKey(expr);
  return undefined;
}

/** Identifier chain of a dotted expression: `["ctx","blobs","put"]` for
 * `ctx.blobs.put` or `ctx["blobs"].put`, `["this","db"]` for `this.db`.
 * Undefined for anything that is not a pure identifier / `this` / property or
 * literal-key element access chain. */
export function propertyChain(expr: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
  if (ts.isPropertyAccessExpression(expr)) {
    const head = propertyChain(expr.expression);
    return head === undefined ? undefined : [...head, expr.name.text];
  }
  if (ts.isElementAccessExpression(expr)) {
    const key = literalKey(expr);
    const head = key === undefined ? undefined : propertyChain(expr.expression);
    return head === undefined || key === undefined ? undefined : [...head, key];
  }
  return undefined;
}

export interface CallInfo {
  /** Tail identifier of the callee. */
  name: string;
  /** Dotted callee (`JSON.stringify`, also for `JSON["stringify"]`); the raw
   * source text when the callee is not a {@link propertyChain}. */
  text: string;
  node: ts.CallExpression;
}

/** Receiver names that denote the global object when no local binding shadows
 * them. */
export const GLOBAL_RECEIVERS: ReadonlySet<string> = new Set(["globalThis", "global", "self", "window"]);

export type CalleeForwarder = "call" | "apply" | "bind";

export interface NormalizedCallee {
  /** Dotted path rooted at a global name or at an opaque local binding (a
   * parameter, an import, a non-alias initializer). `[]` is the global object. */
  chain: string[];
  /** Set when the callee was reached through `.call` / `.apply` / `.bind`. */
  forwarder?: CalleeForwarder;
}

const MAX_ALIAS_DEPTH = 8;

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e)
    )
      e = e.expression;
    else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) e = e.right;
    else return e;
  }
}

interface RawChain {
  /** An identifier, or `this`. */
  head: ts.Expression;
  keys: string[];
}

function rawChain(expr: ts.Expression): RawChain | undefined {
  const e = unwrapExpression(expr);
  if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return { head: e, keys: [] };
  if (ts.isPropertyAccessExpression(e)) {
    const inner = rawChain(e.expression);
    return inner === undefined ? undefined : { head: inner.head, keys: [...inner.keys, e.name.text] };
  }
  if (ts.isElementAccessExpression(e)) {
    const key = literalKey(e);
    const inner = key === undefined ? undefined : rawChain(e.expression);
    return inner === undefined || key === undefined ? undefined : { head: inner.head, keys: [...inner.keys, key] };
  }
  return undefined;
}

function isForwarder(name: string | undefined): name is CalleeForwarder {
  return name === "call" || name === "apply" || name === "bind";
}

function splitForwarder(expr: ts.Expression): { target: ts.Expression; forwarder?: CalleeForwarder } {
  const e = unwrapExpression(expr);
  if (ts.isPropertyAccessExpression(e) && isForwarder(e.name.text))
    return { target: e.expression, forwarder: e.name.text };
  if (ts.isElementAccessExpression(e)) {
    const key = literalKey(e);
    if (isForwarder(key)) return { target: e.expression, forwarder: key };
  }
  return { target: e };
}

/** What an alias initializer stands for: `x` for `x.bind(…)`, else itself. */
function aliasTarget(init: ts.Expression): ts.Expression {
  const e = unwrapExpression(init);
  if (ts.isCallExpression(e)) {
    const split = splitForwarder(e.expression);
    if (split.forwarder === "bind") return split.target;
  }
  return e;
}

function propertyKeyText(n: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) ? n.text : undefined;
}

/** Key path from a binding pattern's initializer to `target`: `[]` for a plain
 * identifier, `["a","b"]` for `{ a: { b: target } }`; `null` when `target` is
 * bound unresolvably (array pattern, rest, computed key); `undefined` when the
 * pattern does not bind it. */
function bindingPath(name: ts.BindingName, target: string): string[] | null | undefined {
  if (ts.isIdentifier(name)) return name.text === target ? [] : undefined;
  if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements)
      if (ts.isBindingElement(el) && bindingPath(el.name, target) !== undefined) return null;
    return undefined;
  }
  for (const el of name.elements) {
    const sub = bindingPath(el.name, target);
    if (sub === undefined) continue;
    if (sub === null || el.dotDotDotToken !== undefined) return null;
    const key = propertyKeyText(el.propertyName ?? el.name);
    return key === undefined ? null : [key, ...sub];
  }
  return undefined;
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) if (ts.isBindingElement(el)) out.push(...boundNames(el.name));
  return out;
}

interface AliasBinding {
  init: ts.Expression;
  path: string[];
}

/** How one block binds `name`: an alias, `null` for an opaque binding, or
 * `undefined` when the block does not declare it. */
function statementBinding(statements: ts.NodeArray<ts.Statement>, name: string): AliasBinding | null | undefined {
  for (const stmt of statements) {
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) &&
      stmt.name?.text === name
    )
      return null;
    if (ts.isImportDeclaration(stmt) && importBindsName(stmt, name)) return null;
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      const path = bindingPath(decl.name, name);
      if (path === undefined) continue;
      return path === null || decl.initializer === undefined ? null : { init: decl.initializer, path };
    }
  }
  return undefined;
}

function loopBindsName(scope: ts.Node, name: string): boolean {
  if (!(ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))) return false;
  const init = scope.initializer;
  return (
    init !== undefined &&
    ts.isVariableDeclarationList(init) &&
    init.declarations.some((d) => bindingPath(d.name, name) !== undefined)
  );
}

/** Innermost binding of `id`: an alias, `null` when opaque (parameter, function,
 * class, import, catch / loop variable, uninitialised declaration), or
 * `undefined` when unbound in the file (a global). */
function findBinding(id: ts.Identifier): AliasBinding | null | undefined {
  const name = id.text;
  for (let scope: ts.Node | undefined = id.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => bindingPath(p.name, name) !== undefined)) return null;
    if ((ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name?.text === name) return null;
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration !== undefined &&
      bindingPath(scope.variableDeclaration.name, name) !== undefined
    )
      return null;
    if (loopBindsName(scope, name)) return null;
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseOrDefaultClause(scope)) {
      const bound = statementBinding(scope.statements, name);
      if (bound !== undefined) return bound;
    }
  }
  return undefined;
}

function resolveIdentifier(id: ts.Identifier, depth: number): string[] {
  const binding = findBinding(id);
  if (binding === undefined) return GLOBAL_RECEIVERS.has(id.text) ? [] : [id.text];
  if (binding === null || depth >= MAX_ALIAS_DEPTH) return [id.text];
  const base = resolveChain(aliasTarget(binding.init), depth + 1);
  return base === undefined ? [id.text] : [...base, ...binding.path];
}

function resolveChain(expr: ts.Expression, depth: number): string[] | undefined {
  const raw = rawChain(expr);
  if (raw === undefined) return undefined;
  const prefix = ts.isIdentifier(raw.head) ? resolveIdentifier(raw.head, depth) : ["this"];
  const keys = [...raw.keys];
  while (prefix.length === 0 && keys[0] !== undefined && GLOBAL_RECEIVERS.has(keys[0])) keys.shift();
  return [...prefix, ...keys];
}

/** Canonical dotted form of a callee (or any member-access chain), shared by
 * every discipline lint so a forbidden reach can't hide behind syntax:
 * `globalThis.JSON["stringify"]`, `const J = JSON; J.stringify`,
 * `const { stringify } = JSON; stringify` and `JSON.stringify.call(…)` all
 * yield `["JSON","stringify"]`. A global receiver is only stripped when no
 * local binding shadows its name. Undefined when the expression is not a
 * statically-resolvable chain. */
export function normalizeCallee(expr: ts.Expression): NormalizedCallee | undefined {
  const { target, forwarder } = splitForwarder(expr);
  const chain = resolveChain(target, 0);
  if (chain === undefined) return undefined;
  return forwarder === undefined ? { chain } : { chain, forwarder };
}

/** All call expressions under `root`. `skipNested` excludes calls inside nested
 * deferred functions (used for transaction bodies). */
export function collectCalls(root: ts.Node, sf: ts.SourceFile, skipNested = false): CallInfo[] {
  const out: CallInfo[] = [];
  walk(
    root,
    (n) => {
      if (ts.isCallExpression(n)) {
        const chain = propertyChain(n.expression);
        const text = chain === undefined ? n.expression.getText(sf) : chain.join(".");
        out.push({ name: calleeName(n.expression) ?? "", text, node: n });
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

function hasParameterNamed(fn: ts.SignatureDeclaration, name: string): boolean {
  return fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
}

/** How the first same-named declaration in one block binds `name`: the body it
 * resolves to, `null` when it binds something unresolvable (a `let`/`var`, a
 * non-function `const`, a class, an import), or `undefined` when the block
 * declares no such name. */
function blockBinding(statements: ts.NodeArray<ts.Statement>, name: string): ts.Node | null | undefined {
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      if (stmt.body !== undefined) return stmt.body;
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) return null;
    if (ts.isImportDeclaration(stmt) && importBindsName(stmt, name)) return null;
    if (!ts.isVariableStatement(stmt)) continue;
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
      const init = decl.initializer;
      if (isConst && init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
        return init.body;
      return null;
    }
  }
  return undefined;
}

function importBindsName(stmt: ts.ImportDeclaration, name: string): boolean {
  const clause = stmt.importClause;
  if (clause === undefined) return false;
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((e) => e.name.text === name);
}

/** Body of a `const name = () => …` / `function name() {…}` declared in a block
 * enclosing `id` (or at file top), searched innermost-first. The innermost
 * binding of the name wins: a same-named parameter or any other declaration
 * (`let`, a non-function `const`, an import) shadows outer ones, so the
 * identifier stays unresolved rather than resolving to an outer function. */
function resolveLocalFunctionBody(id: ts.Identifier): ts.Node | undefined {
  const name = id.text;
  for (let scope: ts.Node | undefined = id.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && hasParameterNamed(scope, name)) return undefined;
    if (!(ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseOrDefaultClause(scope)))
      continue;
    const bound = blockBinding(scope.statements, name);
    if (bound !== undefined) return bound ?? undefined;
  }
  return undefined;
}

/** Name a function-like node is declared or assigned under: `f` for
 * `function f`, `m() {}`, `{ m: () => … }`, `const f = () => …`. */
function declaredName(fn: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined && ts.isIdentifier(fn.name))
    return fn.name.text;
  const p = fn.parent;
  if (
    (ts.isPropertyAssignment(p) || ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) &&
    ts.isIdentifier(p.name)
  )
    return p.name.text;
  return undefined;
}

/** True for `writeTxn: (fn) => this.writeTxn(fn)` — a function itself named as
 * one of `names` forwarding its own parameter. Its callers are scanned at their
 * own call sites, so the forwarded identifier needs no resolution. */
function forwardsOwnParameter(id: ts.Identifier, names: Set<string>): boolean {
  let fn: ts.Node | undefined = id.parent;
  while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (fn === undefined || !ts.isFunctionLike(fn) || !hasParameterNamed(fn, id.text)) return false;
  const name = declaredName(fn);
  return name !== undefined && names.has(name);
}

export interface CallbackScope {
  /** The callback body, or the call itself when `unresolved`. */
  body: ts.Node;
  /** The callback could not be resolved statically; `body` is the call node. */
  unresolved: boolean;
}

/** Callback scope of every call to one of `calleeNames` — e.g. `writeTxn(() => {
 * ... })`. A first argument passed by name is resolved through the enclosing
 * `const` / function declarations to its body; when it can't be resolved, the
 * call node itself is returned with `unresolved` set so the caller can flag it. */
export function callbackBodiesOf(sf: ts.SourceFile, calleeNames: readonly string[]): CallbackScope[] {
  const names = new Set(calleeNames);
  const out: CallbackScope[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n.expression);
    if (name === undefined || !names.has(name)) return;
    const arg = n.arguments[0];
    if (arg === undefined) return;
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      out.push({ body: arg.body, unresolved: false });
      return;
    }
    if (ts.isIdentifier(arg)) {
      const body = resolveLocalFunctionBody(arg);
      if (body !== undefined) {
        out.push({ body, unresolved: false });
        return;
      }
      if (forwardsOwnParameter(arg, names)) return;
    }
    out.push({ body: n, unresolved: true });
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

/** Method name → body for the methods of the class `className` declared in
 * `sf` (unlike {@link sameFileFunctionBodies}, which mixes every class and free
 * function in the file together). */
export function classMethodBodies(sf: ts.SourceFile, className: string): Map<string, ts.Node> {
  const map = new Map<string, ts.Node>();
  walk(sf, (n) => {
    if (!ts.isClassDeclaration(n) || n.name?.text !== className) return;
    for (const member of n.members) {
      if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body !== undefined) {
        map.set(member.name.text, member.body);
      }
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

/** Module recorded for a dynamic `import()` / `require()` whose specifier is not
 * a literal — the lints cannot know what it loads, so they report it. */
export const DYNAMIC_SPECIFIER = "<dynamic>";

export interface ImportInfo {
  module: string;
  kind: "static" | "dynamic" | "require";
  typeOnly: boolean;
  node: ts.Node;
}

/** Specifier of a dynamic `import()` / `require()` argument: the literal text
 * (string or no-substitution template), else {@link DYNAMIC_SPECIFIER}. */
function dynamicSpecifier(arg: ts.Expression): string {
  return ts.isStringLiteralLike(arg) ? arg.text : DYNAMIC_SPECIFIER;
}

/** Head identifiers a `require` reach can start from in this file: `require`,
 * the global receivers, and every local name aliased (transitively) off one. A
 * cheap prefilter so `normalizeCallee` only runs on plausible calls. */
function requireCandidateHeads(sf: ts.SourceFile): Set<string> {
  const heads = new Set<string>(["require", ...GLOBAL_RECEIVERS]);
  const aliases: Array<{ names: string[]; head: string }> = [];
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || n.initializer === undefined) return;
    const head = rawChain(aliasTarget(n.initializer))?.head;
    if (head !== undefined && ts.isIdentifier(head)) aliases.push({ names: boundNames(n.name), head: head.text });
  });
  for (let grew = true; grew; ) {
    grew = false;
    for (const alias of aliases) {
      if (!heads.has(alias.head)) continue;
      for (const name of alias.names) {
        if (heads.has(name)) continue;
        heads.add(name);
        grew = true;
      }
    }
  }
  return heads;
}

/** Specifier a `require` call loads: argument 0, argument 1 behind `.call`,
 * and {@link DYNAMIC_SPECIFIER} behind `.apply` / `.bind`. */
function requireSpecifier(call: ts.CallExpression, forwarder: CalleeForwarder | undefined): string | undefined {
  if (forwarder === "apply" || forwarder === "bind") return DYNAMIC_SPECIFIER;
  const arg = call.arguments[forwarder === "call" ? 1 : 0];
  return arg === undefined ? undefined : dynamicSpecifier(arg);
}

function requireCallSpecifier(call: ts.CallExpression, heads: Set<string>): string | undefined {
  const head = rawChain(call.expression)?.head;
  if (head === undefined || !ts.isIdentifier(head) || !heads.has(head.text)) return undefined;
  const callee = normalizeCallee(call.expression);
  if (callee === undefined || callee.chain.length !== 1 || callee.chain[0] !== "require") return undefined;
  return requireSpecifier(call, callee.forwarder);
}

/** All module references: static `import`/`export … from`, dynamic `import()`
 * calls, and `require()` calls — including `require` reached through an alias,
 * a destructuring, a global receiver, or `.call` / `.apply` / `.bind` (see
 * {@link normalizeCallee}). A non-literal `import()`/`require()` specifier is
 * recorded as {@link DYNAMIC_SPECIFIER}. Type-position `import("x").Y` (an
 * ImportTypeNode, not a call) is naturally excluded — it carries no runtime import. */
export function collectImports(sf: ts.SourceFile): ImportInfo[] {
  const out: ImportInfo[] = [];
  const requireHeads = requireCandidateHeads(sf);
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
      if (arg !== undefined) out.push({ module: dynamicSpecifier(arg), kind: "dynamic", typeOnly: false, node: n });
    } else if (ts.isCallExpression(n)) {
      const module = requireCallSpecifier(n, requireHeads);
      if (module !== undefined) out.push({ module, kind: "require", typeOnly: false, node: n });
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
