// SSRF guard for outbound HTTP. Rejects non-http(s) schemes and resolves the
// hostname to block loopback, link-local, and RFC1918 ranges before the fetch.

import { promises as dns } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Parse + validate the URL, then DNS-resolve and reject private addresses.
 * Throws SsrfError if the URL is unsafe. Returns the parsed URL on success. */
export async function assertSafeUrl(
  urlString: string,
  opts: { lookup?: (host: string) => Promise<Array<{ address: string }>> } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new SsrfError(`invalid URL: ${urlString}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`refused scheme "${url.protocol}" — only http(s) allowed`);
  }

  const host = url.hostname;
  // If host is already an IP literal, validate directly; otherwise resolve.
  const ips = isIPv4(host) || isIPv6(host) ? [{ address: host }] : await resolve(host, opts.lookup);
  if (ips.length === 0) {
    throw new SsrfError(`could not resolve ${host}`);
  }
  for (const { address } of ips) {
    if (isPrivateAddress(address)) {
      throw new SsrfError(`refused: ${host} resolves to private/loopback address ${address}`);
    }
  }
  return url;
}

async function resolve(
  host: string,
  lookup?: (host: string) => Promise<Array<{ address: string }>>,
): Promise<Array<{ address: string }>> {
  if (lookup) return lookup(host);
  try {
    return await dns.lookup(host, { all: true });
  } catch (err) {
    throw new SsrfError(`DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** True if address is loopback, link-local, or in an RFC1918/RFC4193/etc. private range. */
export function isPrivateAddress(address: string): boolean {
  if (isIPv4(address)) return isPrivateIPv4(address);
  if (isIPv6(address)) return isPrivateIPv6(address);
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. AWS metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true; // loopback, unspecified
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — extract and re-check
  const mapped = /^::ffff:([0-9.]+)$/.exec(normalized);
  if (mapped?.[1] && isIPv4(mapped[1])) return isPrivateIPv4(mapped[1]);
  return false;
}
