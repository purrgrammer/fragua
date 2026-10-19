export function readHomeAndSpawn(): unknown {
  const home = globalThis.process.env["HOME"];
  globalThis.Bun.spawn(["true"]);
  return home;
}
