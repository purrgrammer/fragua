export async function pingAndSpawn(u: string): Promise<unknown> {
  const res = await fetch(u);
  Bun.spawn(["true"]);
  return res.status;
}
