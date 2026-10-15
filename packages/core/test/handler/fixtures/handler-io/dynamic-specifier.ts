// Fixture: a handler module loading a module through a template-literal and a
// computed `import()` specifier — neither is a plain string literal.

export async function loadModules(spec: string): Promise<unknown[]> {
  const fs = await import(`node:fs`);
  const other = await import(spec);
  return [fs, other];
}
