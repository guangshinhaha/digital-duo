/**
 * Thrown by `assertServableHost` — refusing to start is the actual
 * enforcement behind AR-12 (`client-design.md`): a daemon holding a
 * decrypted government corpus must not be one absent flag away from
 * listening on every interface.
 */
export class UnsafeBindHostError extends Error {
  constructor(host: string | undefined, reason: string) {
    super(`Refusing to bind duo serve to ${host ? `"${host}"` : "no host"}: ${reason}. Pass --host <tailnet-ip>, or bind loopback explicitly with --host 127.0.0.1.`);
    this.name = "UnsafeBindHostError";
  }
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*"]);

/**
 * `duo serve` must never fall back to "every interface" by omission. A
 * host must be given explicitly, and it must not be one of the wildcard
 * spellings — loopback (127.0.0.1 / ::1) and any other explicit address
 * (a tailnet IP, a specific NIC) are both fine, because both are a
 * deliberate choice rather than a default nobody made.
 */
export function assertServableHost(host: string | undefined): asserts host is string {
  if (host === undefined || host.length === 0) {
    throw new UnsafeBindHostError(host, "no host was given");
  }
  if (WILDCARD_HOSTS.has(host)) {
    throw new UnsafeBindHostError(host, "binding every interface is never allowed");
  }
}
