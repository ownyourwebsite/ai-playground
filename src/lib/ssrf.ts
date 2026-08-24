/**
 * Shared SSRF protection helpers.
 *
 * Used by both `/api/mcp` (the MCP proxy) and `/api/chat` (to guard the
 * attacker-controlled `ollamaUrl`). All checks are deny-by-default: anything
 * that cannot be proven public is rejected.
 */
import { isIP } from "net";
import { lookup as lookupAsync } from "dns/promises";
import { lookup as lookupCb } from "dns";
import http from "http";
import https from "https";
import type { IncomingHttpHeaders } from "http";

/** When true (local development only), private/http targets are permitted. */
export const ALLOW_PRIVATE_MCP = process.env.ALLOW_PRIVATE_MCP === "1";

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
  if (!ALLOW_PRIVATE_MCP && url.protocol !== "https:") {
    throw new Error("Non-HTTPS URLs are restricted on hosted deployments");
  }

  if (ALLOW_PRIVATE_MCP) return url; // local development: everything allowed

  const hostname = stripBrackets(url.hostname);

  if (isPrivateHostname(hostname)) {
    throw new Error("Access to private hosts is restricted");
  }

  // Reject non-dotted numeric hostnames (decimal "2130706433", hex "0x7f000001")
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
    throw new Error("Numeric-encoded hostnames are not allowed");
  }

  if (isIP(hostname)) {
    if (isPrivateIPAddress(hostname)) {
      throw new Error("Access to private IP addresses is restricted");
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
      throw new Error("Host resolves to a private address");
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

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

interface LookupAddress {
  address: string;
  family: number;
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
        /**
         * Custom dns.lookup: resolves the hostname and rejects any address
         * that is private. Because http/https use this lookup for the real
         * connection, a rebinding DNS server cannot slip a private address
         * past us between validation and connect.
         */
        const validatingLookup = (
          hostname: string,
          options: { all?: boolean; family?: number },
          callback: LookupCallback
        ): void => {
          lookupCb(hostname, { all: true }, (err, addresses) => {
            if (err) {
              callback(err, []);
              return;
            }
            const publicAddrs = (addresses ?? []).filter(
              (a) => !isPrivateIPAddress(a.address)
            );
            if (publicAddrs.length === 0) {
              const e: NodeJS.ErrnoException = new Error(
                "Host resolved to a private address"
              );
              e.code = "EBLOCKED";
              callback(e, []);
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

        const transport = url.protocol === "https:" ? https : http;
        const req = transport.request(
          url,
          {
            method: opts.method ?? "GET",
            headers: opts.headers ?? {},
            lookup: ALLOW_PRIVATE_MCP ? undefined : (validatingLookup as never),
            // Keep TLS SNI / certificate validation tied to the hostname.
            servername: url.protocol === "https:" ? stripBrackets(url.hostname) : undefined,
            timeout: timeoutMs,
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
