import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { env, parseTrustProxyHops } from "../src/config/env";
import { createApp } from "../src/app";

/**
 * Rate limits per client behind a proxy (ARCH N4, NFR-004, AUT-026).
 *
 * Requests carry the header nginx produces with `$proxy_add_x_forwarded_for`: whatever the client
 * sent, then the address nginx saw. So `X-Forwarded-For: <forged>, <real>`.
 */

const savedHops = env.trustProxyHops;
const servers: Server[] = [];

async function startApp(hops: number): Promise<string> {
  env.trustProxyHops = hops;
  const server = createApp().listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  env.trustProxyHops = savedHops;
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A failed login, as seen through the proxy. The /auth limiter allows 20 per 15 minutes. */
async function login(base: string, forwardedFor: string): Promise<number> {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
  });
  return res.status;
}

describe("trust proxy", () => {
  it("NFR-004: with one hop, each real client has its own /auth budget", async () => {
    const base = await startApp(1);

    for (let i = 0; i < 20; i++) expect(await login(base, "198.51.100.1")).toBe(401);
    expect(await login(base, "198.51.100.1")).toBe(429);

    // A different phone is unaffected.
    expect(await login(base, "198.51.100.2")).toBe(401);
  });

  it("AUT-026: forging a prefix doesn't buy a new budget; only the address nginx appended counts", async () => {
    const base = await startApp(1);

    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push(await login(base, `203.0.113.${i}, 198.51.100.9`));

    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("with the default 0, a forwarded header is ignored entirely (nothing to spoof)", async () => {
    const base = await startApp(0);

    // Different claimed addresses, one real peer: they all share one budget.
    for (let i = 0; i < 20; i++) expect(await login(base, `198.51.100.${i}`)).toBe(401);
    expect(await login(base, "198.51.100.200")).toBe(429);
  });

  it("parses only a whole number of proxies", () => {
    expect(parseTrustProxyHops(undefined)).toBe(0);
    expect(parseTrustProxyHops("")).toBe(0);
    expect(parseTrustProxyHops("1")).toBe(1);
    expect(parseTrustProxyHops(" 2 ")).toBe(2);
    for (const bad of ["true", "yes", "-1", "1.5", "loopback", "1,2"]) {
      expect(() => parseTrustProxyHops(bad)).toThrow(/whole number/);
    }
  });
});
