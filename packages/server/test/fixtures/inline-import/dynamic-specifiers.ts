// Fixture: inline module loads whose specifier is not a plain string literal.

export async function loadTemplate(): Promise<unknown> {
  return import(`node:path`);
}

export async function loadComputed(spec: string): Promise<unknown> {
  return import(spec);
}

export function requireTemplate(): unknown {
  return require(`node:fs`);
}
