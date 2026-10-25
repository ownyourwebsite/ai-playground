/**
 * Shared SSRF protection helpers.
 *
 * Used by `/api/mcp` (the MCP proxy) and `/api/chat` (to guard attacker-
 * controlled provider URLs, e.g. Ollama / OpenAI-compatible base URLs). All
 * checks are deny-by-default: anything that cannot be proven public is rejected.
 */
import { isIP } from "net";
import { lookup as lookupAsync } from "dns/promises";
import { lookup as lookupCb } from "dns";
import http from "http";
import https from "https";
import { pipeline, Readable } from "stream";
import { createBrotliDecompress, createGunzip, createInflate } from "zlib";
import type { IncomingHttpHeaders, IncomingMessage } from "http";

/**
 * True when private/LAN/http targets are permitted: `npm run dev`, or an
 * explicit opt-in via ALLOW_PRIVATE_NETWORK=1 (ALLOW_PRIVATE_MCP=1 is the
 * deprecated alias). Evaluated at call time so tests can toggle env.
 * Production builds (Vercel, Docker, `next start`) block private targets
 * unless opted in.
 */
export function privateNetworkAllowed(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    process.env.ALLOW_PRIVATE_NETWORK === "1" ||
    process.env.ALLOW_PRIVATE_MCP === "1"
  );
}

/** Thrown when a target is rejected by SSRF policy. `code` is stable ("EBLOCKED"). */
export class SsrfBlockedError extends Error {
  readonly code = "EBLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/* ------------------------------------------------------------------ */
/* Hostname checks                                                     */
/* ------------------------------------------------------------------ */

export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, ""); // strip trailing dot (FQDN form)
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  // Cloud metadata endpoints that live on "public-looking" names
  if (h === "metadata.google.internal") return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* IP address checks                                                   */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable -> treat as unsafe

  const range = (cidr: string): boolean => {
    const [base, bitsStr] = cidr.split("/");
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) return false;
    const bits = Number(bitsStr);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (baseInt & mask);
  };

  return (
    range("0.0.0.0/8") || // "this network"
    range("10.0.0.0/8") || // private
    range("100.64.0.0/10") || // CGNAT (carrier-grade NAT)
    range("127.0.0.0/8") || // loopback
    range("169.254.0.0/16") || // link-local (incl. 169.254.169.254 metadata)
    range("172.16.0.0/12") || // private
    range("192.0.0.0/24") || // IETF protocol assignments
    range("192.0.2.0/24") || // TEST-NET-1
    range("192.168.0.0/16") || // private
    range("198.18.0.0/15") || // benchmarking
    range("198.51.100.0/24") || // TEST-NET-2
    range("203.0.113.0/24") || // TEST-NET-3
    range("224.0.0.0/4") || // multicast
    range("240.0.0.0/4") // reserved (incl. broadcast)
  );
}

/** Expands an IPv6 address into 8 numeric hextet strings, or null if invalid. */
function expandIPv6(ip: string): number[] | null {
  const doubleColonParts = ip.split("::");
  if (doubleColonParts.length > 2) return null;

  const head = doubleColonParts[0];
  const tail = doubleColonParts.length === 2 ? doubleColonParts[1] : "";

  const headGroups = head === "" ? [] : head.split(":");
  let tailGroups = tail === "" ? [] : tail.split(":");

  // Handle IPv4-mapped dotted tail, e.g. "::ffff:127.0.0.1"
  if (tailGroups.length > 0 && tailGroups[tailGroups.length - 1].includes(".")) {
    const dotted = tailGroups[tailGroups.length - 1];
    const n = ipv4ToInt(dotted);
    if (n === null) return null;
    tailGroups = [
      ...tailGroups.slice(0, -1),
      ((n >>> 16) & 0xffff).toString(16),
      (n & 0xffff).toString(16),
    ];
  }

  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  if (doubleColonParts.length === 1 && missing !== 0) return null;

  const filler = doubleColonParts.length === 2 ? Array(missing).fill("0") : [];
  const groups = [...headGroups, ...filler, ...tailGroups];
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

function ipv4FromHextets(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateIPAddress(rawIp: string): boolean {
  // Strip IPv6 zone id, e.g. "fe80::1%eth0"
  const ip = rawIp.toLowerCase().split("%")[0];

  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);

  if (family === 6) {
    const nums = expandIPv6(ip);
    if (!nums) return true; // unparseable -> unsafe

    const allZero = nums.every((n) => n === 0);
    if (allZero) return true; // "::" unspecified address

    // "::1" loopback
    if (nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1) return true;

    // "::ffff:x.y.z.w" IPv4-mapped (::ffff:0:0/96)
    if (nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff) {
      return isPrivateIPv4(ipv4FromHextets(nums[6], nums[7]));
    }

    // Deprecated IPv4-compatible "::x.y.z.w" (first 6 groups zero)
    if (nums.slice(0, 6).every((n) => n === 0)) {
      return isPrivateIPv4(ipv4FromHextets(nums[6], nums[7]));
    }

    // IPv4-translated ::ffff:0:x.y.z.w (::ffff:0:0:0/96)
    if (nums.slice(0, 4).every((n) => n === 0) && nums[4] === 0xffff && nums[5] === 0) {
      return isPrivateIPv4(ipv4FromHextets(nums[6], nums[7]));
    }

    // NAT64 well-known prefix 64:ff9b::/96 -> embedded IPv4 in the last 32 bits
    if (
      nums[0] === 0x64 && nums[1] === 0xff9b &&
      nums.slice(2, 6).every((n) => n === 0)
    ) {
      return isPrivateIPv4(ipv4FromHextets(nums[6], nums[7]));
    }

    // 64:ff9b:1::/48 local-use NAT64: arbitrary operator mapping, always blocked
    if (nums[0] === 0x64 && nums[1] === 0xff9b && nums[2] === 1) return true;

    // 6to4 2002::/16 -> embedded IPv4 in bits 16..47
    if (nums[0] === 0x2002) return isPrivateIPv4(ipv4FromHextets(nums[1], nums[2]));

    // Teredo 2001:0000::/32: client address is obfuscated, so block it all
    if (nums[0] === 0x2001 && nums[1] === 0) return true;

    // 100::/64 discard-only prefix
    if (nums[0] === 0x100 && nums.slice(1, 4).every((n) => n === 0)) return true;

    // ff00::/8 multicast
    if (nums[0] >= 0xff00) return true;

    // fc00::/7 unique local addresses (fc00:: - fdff::)
    if (nums[0] >= 0xfc00 && nums[0] <= 0xfdff) return true;

    // fe80::/10 link-local (fe80:: - febf::)
    if (nums[0] >= 0xfe80 && nums[0] <= 0xfebf) return true;

    // 2001:db8::/32 documentation-only
    if (nums[0] === 0x2001 && nums[1] === 0x0db8) return true;

    return false;
  }

  // Not a valid IP -> treat as unsafe
  return true;
}

/* ------------------------------------------------------------------ */
/* URL-level validation                                                */
/* ------------------------------------------------------------------ */

/** Strips brackets from IPv6 literals in URL.hostnames: "[::1]" -> "::1". */
export function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Validates that a URL is safe to request from a public deployment:
 * HTTPS-only, no private hostnames/IP literals, no exotic encodings, and
 * (for domain names) that DNS resolves to public addresses only.
 *
 * Throws an Error with a safe, user-facing message when rejected.
 */
export async function assertUrlIsPublic(urlStr: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error("Invalid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
  const allowPrivate = privateNetworkAllowed();
  if (!allowPrivate && url.protocol !== "https:") {
    throw new SsrfBlockedError("Non-HTTPS URLs are restricted on hosted deployments");
  }

  if (allowPrivate) return url; // dev / explicit opt-in: everything allowed

  const hostname = stripBrackets(url.hostname);

  if (isPrivateHostname(hostname)) {
    throw new SsrfBlockedError("Access to private hosts is restricted");
  }

  // Reject non-dotted numeric hostnames (decimal "2130706433", hex "0x7f000001")
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
    throw new SsrfBlockedError("Numeric-encoded hostnames are not allowed");
  }

  if (isIP(hostname)) {
    if (isPrivateIPAddress(hostname)) {
      throw new SsrfBlockedError("Access to private IP addresses is restricted");
    }
    return url;
  }

  // Fail-fast DNS check. The actual connection re-validates every resolved
  // address (see ssrfGuardedFetch), which closes the DNS-rebinding window.
  let addresses;
  try {
    addresses = await lookupAsync(hostname, { all: true });
  } catch {
    throw new Error("Cannot resolve the MCP server host");
  }
  if (!addresses || addresses.length === 0) {
    throw new Error("Cannot resolve the MCP server host");
  }
  for (const addr of addresses) {
    if (isPrivateIPAddress(addr.address)) {
      throw new SsrfBlockedError("Host resolves to a private address");
    }
  }

  return url;
}

/** Boolean convenience wrapper around {@link assertUrlIsPublic}. */
export async function isUrlSsrfSafe(urlStr: string): Promise<boolean> {
  try {
    await assertUrlIsPublic(urlStr);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* SSRF-guarded fetch                                                  */
/* ------------------------------------------------------------------ */

export interface GuardedFetchOptions {
  signal?: AbortSignal;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  /** Socket inactivity timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default 10 MB). */
  maxBytes?: number;
}

export interface GuardedFetchResult {
  status: number;
  headers: IncomingHttpHeaders;
  bodyText: string;
  /** True when the body was cut off because it exceeded maxBytes. */
  truncated: boolean;
}

interface LookupAddress {
  address: string;
  family: number;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

type LookupFn = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback
) => void;

/** Resolver used by the validating lookup (dns.lookup shape, `all: true`). */
type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

/**
 * Builds a custom dns.lookup that resolves the hostname and drops every
 * private address. Because http/https use it for the real connection, a
 * rebinding DNS server cannot slip a private address past us between
 * validation and connect. `resolve` is injectable for tests.
 */
export function createValidatingLookup(resolve: Resolver = lookupCb as Resolver): LookupFn {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) {
        callback(err, []);
        return;
      }
      const publicAddrs = (addresses ?? []).filter((a) => !isPrivateIPAddress(a.address));
      if (publicAddrs.length === 0) {
        callback(new SsrfBlockedError("Host resolved to a private address"), []);
        return;
      }
      if (options.all) {
        callback(null, publicAddrs);
        return;
      }
      const pick =
        publicAddrs.find((a) => a.family === (options.family ?? 0)) ?? publicAddrs[0];
      callback(null, pick.address, pick.family);
    });
  };
}

/** TLS SNI name: the hostname for https, none for IP literals (Node warns on those). */
function sniServername(url: URL): string | undefined {
  const host = stripBrackets(url.hostname);
  return url.protocol === "https:" && !isIP(host) ? host : undefined;
}

/**
 * Performs an HTTP(S) request whose DNS resolution is validated at
 * connect-time. Unlike `fetch(url)`, the addresses used for the actual TCP
 * connection are the ones checked here, which eliminates the classic
 * check-then-connect DNS rebinding (TOCTOU) bypass.
 *
 * Redirects are NOT followed (Node's http/https never follow them
 * automatically) — callers decide how to treat 3xx responses.
 */
export function ssrfGuardedFetch(
  urlStr: string,
  opts: GuardedFetchOptions = {}
): Promise<GuardedFetchResult> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15000;

  // Runs the full URL validation (throws on private/invalid targets).
  return assertUrlIsPublic(urlStr).then(
    (url) =>
      new Promise<GuardedFetchResult>((resolve, reject) => {
        const transport = url.protocol === "https:" ? https : http;
        const req = transport.request(
          url,
          {
            method: opts.method ?? "GET",
            headers: opts.headers ?? {},
            lookup: privateNetworkAllowed() ? undefined : (createValidatingLookup() as never),
            // Keep TLS SNI / certificate validation tied to the hostname.
            servername: sniServername(url),
            timeout: timeoutMs,
            signal: opts.signal,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let total = 0;
            let truncated = false;

            res.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > maxBytes) {
                truncated = true;
                req.destroy(new Error("Response payload too large"));
                return;
              }
              chunks.push(chunk);
            });

            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 502,
                headers: res.headers,
                bodyText: Buffer.concat(chunks).toString("utf8"),
                truncated,
              });
            });

            res.on("error", reject);
          }
        );

        req.on("timeout", () => {
          req.destroy(new Error("Gateway timeout"));
        });
        req.on("error", reject);

        if (opts.body != null) {
          req.write(opts.body);
        }
        req.end();
      })
  );
}

/* ------------------------------------------------------------------ */
/* SSRF-safe streaming fetch (for the AI SDK)                          */
/* ------------------------------------------------------------------ */

async function toNodeBody(
  body: BodyInit
): Promise<{ data: Buffer | Readable; type?: string }> {
  if (typeof body === "string") return { data: Buffer.from(body), type: "text/plain;charset=UTF-8" };
  if (body instanceof ArrayBuffer) return { data: Buffer.from(body) };
  if (ArrayBuffer.isView(body)) {
    return { data: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
  }
  if (body instanceof ReadableStream) return { data: Readable.fromWeb(body as never) };
  // URLSearchParams, Blob, FormData: let Response serialise them
  const r = new Response(body);
  return {
    data: Buffer.from(await r.arrayBuffer()),
    type: r.headers.get("content-type") ?? undefined,
  };
}

function decoderFor(encoding: string) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return null;
  }
}

/**
 * fetch() over node http/https with a streaming `Response` body (SSE-safe: no
 * buffering, no inactivity timeout). Redirects are not followed. `lookup` is
 * the DNS lookup used for the connection. @internal: exported for tests, use
 * {@link ssrfSafeFetch}.
 */
export async function streamingFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  lookup?: LookupFn
): Promise<Response> {
  const inReq = input instanceof Request ? input : null;
  const url = new URL(inReq ? inReq.url : String(input));
  const method = (init?.method ?? inReq?.method ?? "GET").toUpperCase();
  const signal = init?.signal ?? inReq?.signal ?? undefined;
  signal?.throwIfAborted();

  const headers = new Headers(inReq?.headers);
  if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));

  const rawBody =
    init?.body ?? (inReq?.body ? new Uint8Array(await inReq.arrayBuffer()) : null);
  if (rawBody != null && (method === "GET" || method === "HEAD")) {
    throw new TypeError("Request with GET/HEAD method cannot have body");
  }
  const body = rawBody == null ? null : await toNodeBody(rawBody);
  if (body?.type && !headers.has("content-type")) headers.set("content-type", body.type);
  if (body && Buffer.isBuffer(body.data)) headers.set("content-length", String(body.data.length));
  // Node does not decompress; ask for plain bytes (decoded below if ignored)
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");

  return new Promise<Response>((resolve, reject) => {
    let res: IncomingMessage | undefined;
    let out: Readable | undefined;

    const onAbort = () => {
      const reason = signal?.reason;
      out?.destroy(reason);
      res?.destroy(reason);
      req.destroy();
      reject(reason);
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers: Object.fromEntries(headers),
        lookup: lookup as never,
        servername: sniServername(url),
      },
      (r) => {
        res = r;
        r.on("close", cleanup);
        const status = r.statusCode ?? 502;
        if (status < 200) {
          // Response() cannot represent 1xx (incl. 101 Switching Protocols)
          r.destroy();
          reject(new Error(`Unsupported HTTP status ${status}`));
          return;
        }

        const headersOut = new Headers();
        for (const [k, v] of Object.entries(r.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headersOut.append(k, x));
          else if (v !== undefined) headersOut.append(k, v);
        }

        if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
          r.resume();
          resolve(new Response(null, { status, statusText: r.statusMessage, headers: headersOut }));
          return;
        }

        const decoder = decoderFor((r.headers["content-encoding"] ?? "").trim().toLowerCase());
        if (decoder) {
          headersOut.delete("content-encoding");
          headersOut.delete("content-length");
          pipeline(r, decoder, () => {});
        }
        out = decoder ?? r;
        resolve(
          new Response(Readable.toWeb(out) as unknown as ReadableStream, {
            status,
            statusText: r.statusMessage,
            headers: headersOut,
          })
        );
      }
    );

    req.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        err.code === "EBLOCKED" && !(err instanceof SsrfBlockedError)
          ? new SsrfBlockedError(err.message)
          : err
      );
    });

    signal?.addEventListener("abort", onAbort, { once: true });

    if (body?.data instanceof Readable) {
      body.data.on("error", (e) => req.destroy(e));
      body.data.pipe(req);
    } else {
      req.end(body?.data);
    }
  });
}

/**
 * `fetch` replacement for user-supplied provider base URLs, e.g.
 * `createOpenAI({ baseURL, fetch: ssrfSafeFetch })`. Validates the URL on every
 * call (throws {@link SsrfBlockedError} for blocked targets) and, unless
 * private networks are allowed, connects through the validating DNS lookup.
 * The response body streams; redirects are returned as is.
 */
export const ssrfSafeFetch: typeof fetch = async (input, init) => {
  await assertUrlIsPublic(input instanceof Request ? input.url : String(input));
  if (privateNetworkAllowed()) return globalThis.fetch(input, init);
  return streamingFetch(input, init, createValidatingLookup());
};
