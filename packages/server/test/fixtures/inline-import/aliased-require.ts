// Fixture (R3-M1): inline `require` reached through an alias, a global
// receiver, a destructuring off the global object, and `.call`.

export function viaAlias(): unknown {
  const r = require;
  return r("node:fs");
}

export function viaGlobalReceiver(): unknown {
  return globalThis.require("node:path");
}

export function viaDestructuring(): unknown {
  const { require: req } = globalThis;
  return req("node:os");
}

export function viaCall(): unknown {
  return require.call(null, "node:url");
}
