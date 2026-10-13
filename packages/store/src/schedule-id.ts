// Schedule id generator — `sch_<rand>`. Lives beside `newRunId` so every
// composition root (server, CLI) injects the same id shape into the intent
// plane; core stays browser-safe, so id minting is a host-side seam.

import { randomBytes } from "node:crypto";

const ALPH = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newScheduleId(): string {
  const buf = randomBytes(6);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += ALPH[buf[i]! % 36];
  return `sch_${s}`;
}
