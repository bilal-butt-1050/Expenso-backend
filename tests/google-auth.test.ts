import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { createApp } from "../src/app";
import { loginWithGoogle, registerUser } from "../src/modules/auth/auth.service";
import { signToken } from "../src/utils/jwt";

/**
 * Google sign-in rules (ARCH N2, threat S2, D-19, D-40). Google itself is stubbed: each test says
 * what the verified token contains.
 */

const savedClientId = env.googleClientIdWeb;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  env.googleClientIdWeb = "test-client-id";
});

afterEach(() => {
  env.googleClientIdWeb = savedClientId;
  vi.restoreAllMocks();
});

interface Claims {
  email: string;
  sub: string;
  email_verified?: boolean;
  hd?: string;
  picture?: string;
}

function googleSays(claims: Claims) {
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => ({ email_verified: true, name: "Google Name", ...claims }),
  } as never);
}

/** Whether a token still opens the API (the tokenVersion check in requireAuth). */
async function tokenWorks(token: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  return res.status === 200;
}

/** A password account, as if registered before verification existed: emailVerifiedAt NULL. */
async function passwordAccount(email: string) {
  const { token, user } = await registerUser(email, "password123", "Password User");
  return { token, id: user.id };
}

const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e) => e.statusCode as number);

describe("Google sign-in", () => {
  it("creates a new account, marked verified", async () => {
    googleSays({ email: "fresh@gmail.com", sub: "g-fresh" });

    const { user } = await loginWithGoogle("token");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.googleId).toBe("g-fresh");
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);
    expect(row.passwordHash).toBeNull();
  });

  it("AUT-023a: a Gmail address with an unproven password account → password cleared, old session dead", async () => {
    const victim = await passwordAccount("victim@gmail.com");
    expect(await tokenWorks(victim.token)).toBe(true);
    googleSays({ email: "victim@gmail.com", sub: "g-victim" });

    const { token } = await loginWithGoogle("token");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.googleId).toBe("g-victim");
    expect(row.tokenVersion).toBe(1);
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await tokenWorks(victim.token)).toBe(false);
    expect(await tokenWorks(token)).toBe(true);
  });

  it("a verified password account keeps its password when Google links", async () => {
    const owner = await passwordAccount("owner@gmail.com");
    await prisma.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: new Date() } });
    googleSays({ email: "owner@gmail.com", sub: "g-owner" });

    await loginWithGoogle("token");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.passwordHash).not.toBeNull();
    expect(row.googleId).toBe("g-owner");
    expect(row.tokenVersion).toBe(0);
    expect(await tokenWorks(owner.token)).toBe(true);
  });

  it("AUT-023b: a non-Google address with an existing account → 409, account unchanged", async () => {
    const owner = await passwordAccount("someone@outlook.com");
    googleSays({ email: "someone@outlook.com", sub: "g-attacker" });

    const err = await loginWithGoogle("token").catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/Sign in with your password/);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.googleId).toBeNull();
    expect(row.passwordHash).not.toBeNull();
    expect(await tokenWorks(owner.token)).toBe(true);
  });

  it("a Workspace account is authoritative for its own domain (hd)", async () => {
    const owner = await passwordAccount("staff@acme.io");
    googleSays({ email: "staff@acme.io", sub: "g-staff", hd: "acme.io" });

    await loginWithGoogle("token");

    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).googleId).toBe("g-staff");
  });

  it("an hd that isn't the address's domain doesn't count", async () => {
    await passwordAccount("staff@acme.io");
    googleSays({ email: "staff@acme.io", sub: "g-other", hd: "evil.io" });

    expect(await statusOf(loginWithGoogle("token"))).toBe(409);
  });

  it("AUT-023c: an account linked to a different Google id → 409", async () => {
    googleSays({ email: "linked@gmail.com", sub: "g-original" });
    await loginWithGoogle("token");
    vi.restoreAllMocks();
    googleSays({ email: "linked@gmail.com", sub: "g-impostor" });

    const err = await loginWithGoogle("token").catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/different Google account/);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "linked@gmail.com" } })).googleId).toBe("g-original");
  });

  it("AUT-023d: found by Google id even after the Google email changed; our email stays", async () => {
    googleSays({ email: "old@gmail.com", sub: "g-stable" });
    const first = await loginWithGoogle("token");
    vi.restoreAllMocks();
    googleSays({ email: "renamed@gmail.com", sub: "g-stable" });

    const second = await loginWithGoogle("token");

    expect(second.user.id).toBe(first.user.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: first.user.id } })).email).toBe("old@gmail.com");
    expect(await prisma.user.count()).toBe(1);
  });

  it("AUT-023e: a token Google rejects → 401, and nothing from it is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockRejectedValue(
      new Error('Token used too late, 1700000000 > 1690000000: {"email":"leak@gmail.com","sub":"g-leak"}')
    );

    const err = await loginWithGoogle("the.raw.token").catch((e) => e);

    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("Invalid Google token");
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(logged).toContain("google token rejected: expired");
    expect(logged).not.toMatch(/leak@gmail\.com|g-leak|the\.raw\.token|1700000000/);
  });

  it("AUT-023f: found by Google id, unproven, with a password → password cleared, old session dead (D-40)", async () => {
    // An account linked before the rule: a password, a Google id, and no proof of ownership.
    const linked = await passwordAccount("linkedearly@gmail.com");
    await prisma.user.update({ where: { id: linked.id }, data: { googleId: "g-early" } });
    googleSays({ email: "linkedearly@gmail.com", sub: "g-early" });

    const { token } = await loginWithGoogle("token");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: linked.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.tokenVersion).toBe(1);
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await tokenWorks(linked.token)).toBe(false);
    expect(await tokenWorks(token)).toBe(true);
  });

  it("found by Google id and already verified: nothing is cleared", async () => {
    const owner = await passwordAccount("fine@gmail.com");
    await prisma.user.update({ where: { id: owner.id }, data: { googleId: "g-fine", emailVerifiedAt: new Date() } });
    googleSays({ email: "fine@gmail.com", sub: "g-fine" });

    await loginWithGoogle("token");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.passwordHash).not.toBeNull();
    expect(row.tokenVersion).toBe(0);
  });

  it("an unverified Google email is refused (403)", async () => {
    googleSays({ email: "x@gmail.com", sub: "g-x", email_verified: false });
    expect(await statusOf(loginWithGoogle("token"))).toBe(403);
  });

  it("the email is matched case-insensitively", async () => {
    const owner = await passwordAccount("mixed@gmail.com");
    googleSays({ email: "Mixed@Gmail.com", sub: "g-mixed" });

    const { user } = await loginWithGoogle("token");

    expect(user.id).toBe(owner.id);
  });

  it("with no client ids configured → 503, and Google is never asked", async () => {
    env.googleClientIdWeb = undefined;
    const verify = vi.spyOn(OAuth2Client.prototype, "verifyIdToken");
    expect(await statusOf(loginWithGoogle("token"))).toBe(503);
    expect(verify).not.toHaveBeenCalled();
  });

  it("a token signed before the password was cleared is rejected, one signed after works", async () => {
    const u = await passwordAccount("tv@gmail.com");
    const stale = signToken({ userId: u.id, tv: 0 });
    googleSays({ email: "tv@gmail.com", sub: "g-tv" });
    await loginWithGoogle("token");
    expect(await tokenWorks(stale)).toBe(false);
    expect(await tokenWorks(signToken({ userId: u.id, tv: 1 }))).toBe(true);
  });
});
