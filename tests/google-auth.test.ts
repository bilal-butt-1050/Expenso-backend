import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { createApp } from "../src/app";
import { changePassword, loginWithGoogle, registerUser } from "../src/modules/auth/auth.service";
import { comparePassword } from "../src/utils/password";
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
  /** Issued-at, in seconds. Defaults to now. */
  iat?: number;
}

function googleSays(claims: Claims) {
  const iat = Math.floor(Date.now() / 1000);
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => ({ email_verified: true, name: "Google Name", iat, ...claims }),
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

  // --- Security review of T3.8 ---------------------------------------------------------------

  it("sub path: a legacy link to an address Google isn't authoritative for keeps its password", async () => {
    // Linked by the old unconditional code: victim@corp.com's password account got some Google id.
    const owner = await passwordAccount("victim@corp.com");
    await prisma.user.update({ where: { id: owner.id }, data: { googleId: "g-squatter" } });
    googleSays({ email: "victim@corp.com", sub: "g-squatter" });

    await loginWithGoogle("token");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.passwordHash).not.toBeNull();
    expect(row.tokenVersion).toBe(0);
    expect(row.emailVerifiedAt).toBeNull();
    expect(await tokenWorks(owner.token)).toBe(true);
  });

  it("sub path: a Google email that no longer matches the stored one proves nothing", async () => {
    const owner = await passwordAccount("mine@gmail.com");
    await prisma.user.update({ where: { id: owner.id }, data: { googleId: "g-moved" } });
    googleSays({ email: "different@gmail.com", sub: "g-moved" });

    await loginWithGoogle("token");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.passwordHash).not.toBeNull();
    expect(row.emailVerifiedAt).toBeNull();
  });

  it("@googlemail.com is authoritative", async () => {
    const owner = await passwordAccount("old@googlemail.com");
    googleSays({ email: "old@googlemail.com", sub: "g-gm" });

    await loginWithGoogle("token");

    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).googleId).toBe("g-gm");
  });

  it("a subdomain address isn't covered by its parent's hd", async () => {
    await passwordAccount("x@mail.acme.io");
    googleSays({ email: "x@mail.acme.io", sub: "g-sub", hd: "acme.io" });
    expect(await statusOf(loginWithGoogle("token"))).toBe(409);
  });

  it("a token without a sub → 401", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({ email: "nosub@gmail.com", email_verified: true }),
    } as never);
    expect(await statusOf(loginWithGoogle("token"))).toBe(401);
  });

  it("Google's certificates unreachable → 503, not 'invalid token'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockRejectedValue(
      new Error("Failed to retrieve verification certificates: getaddrinfo ENOTFOUND www.googleapis.com")
    );
    const err = await loginWithGoogle("token").catch((e) => e);
    expect(err.statusCode).toBe(503);
  });

  it("two concurrent first sign-ins create exactly one account", async () => {
    googleSays({ email: "race@gmail.com", sub: "g-race" });
    const statuses = await Promise.all([statusOf(loginWithGoogle("t")), statusOf(loginWithGoogle("t"))]);
    expect(statuses).toContain(200);
    expect(await prisma.user.count({ where: { email: "race@gmail.com" } })).toBe(1);
  });
});

describe("changePassword after the session ended", () => {
  it("a stale session can't set a password (the reclaim race)", async () => {
    const squatter = await passwordAccount("reclaimed@gmail.com");
    // The owner's Google sign-in clears the squatter's password and ends their session...
    googleSays({ email: "reclaimed@gmail.com", sub: "g-owner2" });
    await loginWithGoogle("token");
    // ...so the squatter's in-flight change, carrying the old token version, must not land.
    const err = await changePassword(squatter.id, 0, undefined, "newpassword1").catch((e) => e);

    expect(err.statusCode).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: squatter.id } })).passwordHash).toBeNull();
  });

  it("a current session changes the password and ends the others", async () => {
    const user = await passwordAccount("changer@gmail.com");

    await changePassword(user.id, 0, "password123", "newpassword1");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await comparePassword("newpassword1", row.passwordHash!)).toBe(true);
    expect(row.tokenVersion).toBe(1);
    expect(await tokenWorks(user.token)).toBe(false);
  });
});

describe("PATCH /auth/password", () => {
  // Its own app per test: the /auth rate limit budget is per app, and this file shares one.
  let local: Server;
  let base: string;
  beforeEach(async () => {
    local = createApp().listen(0);
    await new Promise((resolve) => local.once("listening", resolve));
    base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise((resolve) => local.close(resolve)));

  async function works(token: string): Promise<boolean> {
    const res = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    return res.status === 200;
  }

  async function patchPassword(token: string, body: object) {
    const res = await fetch(`${base}/auth/password`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { token?: string; error?: string } };
  }

  async function me(token: string) {
    const res = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    return (await res.json()) as { hasPassword: boolean };
  }

  /** A Google-only account: no password. Google stays stubbed as this account afterwards. */
  async function googleOnly(email: string, sub: string) {
    googleSays({ email, sub });
    return loginWithGoogle("token");
  }

  it("changing a password returns a working session and ends the old one", async () => {
    const user = await passwordAccount("change-http@gmail.com");

    const res = await patchPassword(user.token, { currentPassword: "password123", newPassword: "newpassword1" });

    expect(res.status).toBe(200);
    expect(await works(res.body.token!)).toBe(true);
    expect(await works(user.token)).toBe(false);
    expect((await me(res.body.token!)).hasPassword).toBe(true);
  });

  it("a wrong current password is a 400 and changes nothing", async () => {
    const user = await passwordAccount("wrong-current@gmail.com");

    const res = await patchPassword(user.token, { currentPassword: "not-it", newPassword: "newpassword1" });

    expect(res.status).toBe(400);
    expect(await works(user.token)).toBe(true);
  });

  it("hasPassword is false on a Google-only account", async () => {
    const { token } = await googleOnly("no-password@gmail.com", "g-nopass");
    expect((await me(token)).hasPassword).toBe(false);
  });

  it("M4: a session alone can't set the first password", async () => {
    const { token, user } = await googleOnly("session-only@gmail.com", "g-session");

    const res = await patchPassword(token, { newPassword: "newpassword1" });

    expect(res.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBeNull();
  });

  it("M4: a fresh Google confirmation for this account sets the first password", async () => {
    const { token, user } = await googleOnly("set-first@gmail.com", "g-setfirst");

    const res = await patchPassword(token, { newPassword: "newpassword1", googleIdToken: "fresh" });

    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await comparePassword("newpassword1", row.passwordHash!)).toBe(true);
    expect(await works(res.body.token!)).toBe(true);
    expect(await works(token)).toBe(false);
  });

  it("M4: a different Google account's confirmation is refused", async () => {
    const { token, user } = await googleOnly("mine@gmail.com", "g-mine");
    googleSays({ email: "attacker@gmail.com", sub: "g-attacker" });

    const res = await patchPassword(token, { newPassword: "newpassword1", googleIdToken: "other" });

    expect(res.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBeNull();
  });

  it("M4: a confirmation older than 10 minutes is refused, without ending the session", async () => {
    const { token } = await googleOnly("stale-proof@gmail.com", "g-stale");
    googleSays({ email: "stale-proof@gmail.com", sub: "g-stale", iat: Math.floor(Date.now() / 1000) - 11 * 60 });

    const res = await patchPassword(token, { newPassword: "newpassword1", googleIdToken: "old" });

    expect(res.status).toBe(400);
    expect(await works(token)).toBe(true);
  });

  it("M4: a Google outage stays a 503, not a 400 or 401", async () => {
    const { token } = await googleOnly("outage@gmail.com", "g-outage");
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockRejectedValue(
      new Error("Failed to retrieve verification certificates: getaddrinfo ENOTFOUND")
    );

    const res = await patchPassword(token, { newPassword: "newpassword1", googleIdToken: "t" });

    expect(res.status).toBe(503);
    expect(await works(token)).toBe(true);
  });

  it("an account with neither a password nor a Google link can't set one", async () => {
    const orphan = await prisma.user.create({ data: { email: "orphan@example.com" } });
    const token = signToken({ userId: orphan.id, tv: 0 });

    const res = await patchPassword(token, { newPassword: "newpassword1", googleIdToken: "t" });

    expect(res.status).toBe(400);
  });

  it("two changes at once: exactly one wins, and only its token works", async () => {
    const user = await passwordAccount("double-submit@gmail.com");
    const body = { currentPassword: "password123", newPassword: "newpassword1" };

    const results = await Promise.all([patchPassword(user.token, body), patchPassword(user.token, body)]);

    const won = results.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await works(won[0].body.token!)).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(1);
  });

  it("M4: a token Google rejects is a 400, not a 401 (a 401 would sign the app out)", async () => {
    const { token } = await googleOnly("bad-proof@gmail.com", "g-bad");
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockRejectedValue(new Error("Invalid token signature"));

    const res = await patchPassword(token, { newPassword: "newpassword1", googleIdToken: "forged" });

    expect(res.status).toBe(400);
    expect(await works(token)).toBe(true);
  });
});
