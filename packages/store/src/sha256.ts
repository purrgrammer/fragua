import { createHash } from "node:crypto";

export function sha256Hex(content: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(content);
  return h.digest("hex");
}
