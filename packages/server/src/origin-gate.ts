// Same-origin gate. The HTTP surface carries no auth, so a browser page on
// another origin must not be able to drive the control plane. This middleware
// refuses cross-origin requests (Origin allow-list), foreign-Host requests
// (DNS-rebinding defence), and non-JSON bodied requests, before any router runs.

import type { Context, MiddlewareHandler, Next } from "hono";

/** Is this host reachable only from this machine? The whole `127.0.0.0/8`
 * block is loopback, not just `127.0.0.1`. `localhost` counts: it is
 * resolver-dependent in principle, but a hosts file that maps it off-loopback
 * is a compromise this gate is not the defence against. */
export function isLoopbackBind(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** A wildcard bind is an explicit operator opt-in to network exposure: no
 * concrete Host or Origin can match it, so the gate falls back to
 * "same-origin as delivered" for those instances. */
function isWildcardBind(host: string): boolean {
  return host === "::" || host === "0.0.0.0";
}

const VITE_DEV_PORT = "5173";

/** `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`); strip them so
 * the value compares against the unbracketed forms `isLoopbackBind` and the
 * bound host use. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export interface OriginGateOptions {
  /** Scheme+host+port the server is bound to. A thunk because the real port
   * is known only after `Bun.serve` returns (port auto-bump). Returns
   * undefined until the listener is bound — before any request can arrive. */
  boundOrigin: () => { host: string; port: number } | undefined;
}

function parsedHost(raw: string | undefined): { hostname: string; port: string } | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const u = new URL(`http://${raw}`);
    return { hostname: bareHost(u.hostname), port: u.port };
  } catch {
    return null;
  }
}

function originAllowed(origin: string, bound: { host: string; port: number } | undefined, hostHeader: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  const host = bareHost(u.hostname);
  const port = u.port;
  if (isLoopbackBind(host) && port === VITE_DEV_PORT) return true;
  if (bound === undefined) return isLoopbackBind(host);
  if (isWildcardBind(bound.host)) {
    const delivered = parsedHost(hostHeader);
    return delivered !== null && host === delivered.hostname && port === delivered.port;
  }
  if (port !== String(bound.port)) return false;
  return isLoopbackBind(host) || host === bound.host;
}

function hostAllowed(hostHeader: string | undefined, bound: { host: string; port: number } | undefined): boolean {
  const parsed = parsedHost(hostHeader);
  if (parsed === null) return false;
  if (isLoopbackBind(parsed.hostname)) return true;
  if (bound === undefined) return false;
  if (isWildcardBind(bound.host)) return true;
  return parsed.hostname === bound.host && parsed.port === String(bound.port);
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A request carries a body when it declares a length, a streamed encoding, or
 * a content-type (a bodyless intent POST sends none). We treat any of these as
 * "bodied" so a text/plain body can't slip past the JSON-only requirement. */
function isBodied(c: Context): boolean {
  const len = c.req.header("content-length");
  if (len !== undefined && len !== "0") return true;
  if (c.req.header("transfer-encoding") !== undefined) return true;
  return c.req.header("content-type") !== undefined;
}

/** The authority the request was delivered to. Prefer the `Host` header (what a
 * real browser sends, and the value Bun reconstructs `req.url` from), falling
 * back to the request URL's host so a synthetic `app.request(path)` — which
 * carries no Host header — resolves to its `localhost` authority. Both agree
 * for real requests, so DNS-rebinding is caught either way. */
function effectiveHost(c: Context): string {
  const header = c.req.header("host");
  if (header !== undefined && header.length > 0) return header;
  try {
    return new URL(c.req.url).host;
  } catch {
    return "";
  }
}

export function createOriginGate(opts: OriginGateOptions): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const bound = opts.boundOrigin();
    const hostHeader = effectiveHost(c);
    const origin = c.req.header("origin");
    if (origin !== undefined && !originAllowed(origin, bound, hostHeader)) {
      return c.json({ error: "cross-origin request refused", code: "forbidden_origin" }, 403);
    }
    if (!hostAllowed(hostHeader, bound)) {
      return c.json({ error: "host not allowed", code: "forbidden_host" }, 403);
    }
    if (BODY_METHODS.has(c.req.method) && isBodied(c)) {
      const ct = c.req.header("content-type");
      if (ct === undefined || !ct.trim().toLowerCase().startsWith("application/json")) {
        return c.json({ error: "content-type must be application/json", code: "unsupported_media_type" }, 415);
      }
    }
    await next();
  };
}
