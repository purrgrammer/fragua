// Shared comparators. Kept in `core`'s browser-safe main entry so every
// package can reach them (`agent`, `workspace`, and `server` all depend on
// core) without duplicating the expression.

/** Compare two strings by UTF-16 code-unit order.
 *
 * Deliberately NOT `localeCompare`. Callers that order inputs to a provider's
 * prompt-cache prefix (tool definitions, the skills catalogue) need an order
 * identical on every machine and every run; `localeCompare` is locale- and
 * ICU-version-dependent, so swapping it in makes the cache prefix
 * machine-dependent. The `<` / `>` comparison is the guarantee, not a
 * stylistic choice.
 *
 * ("Code-unit", not "code-point": `<` compares UTF-16 units, which differs
 * from code-point order for astral-plane characters. Irrelevant for the
 * identifier-shaped strings sorted here, and either way it is *stable*, which
 * is the property that matters.) */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two named records by `name`. See {@link byString}. */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return byString(a.name, b.name);
}
