import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, type MockInstance } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { createApp } from "../src/app";
import { signToken } from "../src/utils/jwt";
import { hashPassword } from "../src/utils/password";
import { completeEmailSignUp, verifyEmailCode } from "../src/modules/auth/auth.service";
import { sendSignInCode } from "../src/modules/auth/otp.service";
import { makeUser } from "./helpers/factories";

/**
 * PWL: passwordless email (D-66). Brevo is never called: `fetch` to it is stubbed and the code is
 * read from the email it was asked to send; calls to the app itself go through for real.
 */

let server: Server;
let base: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const saved = { nodeEnv: process.env.NODE_ENV, brevoApiKey: env.brevoApiKey, resendApiKey: env.resendApiKey, mailFromEmail: env.mailFromEmail };
let fetchSpy: MockInstance<typeof fetch>;
let sent: { to: string; code: string }[];

beforeEach(() => {
  process.env.NODE_ENV = "test";
  env.brevoApiKey = "test-key";
  env.resendApiKey = undefined;
  env.mailFromEmail = "codes@example.com";
  sent = [];
  fetchSpy = vi.spyOn(globalThis, "fetch");
  fetchSpy.mockImplementation(async (url, init) => {
    if (String(url).startsWith(base)) return realFetch(url, init);
    const payload = JSON.parse(String((init as RequestInit).body));
    const code = payload.htmlContent.match(/letter-spacing: 8px;[^>]*>(\d{6})</)[1];
    sent.push({ to: payload.to[0].email, code });
    return new Response(JSON.stringify({ messageId: "<m>" }), { status: 201 });
  });
});

afterEach(() => {
  process.env.NODE_ENV = saved.nodeEnv;
  env.brevoApiKey = saved.brevoApiKey;
  env.resendApiKey = saved.resendApiKey;
  env.mailFromEmail = saved.mailFromEmail;
  vi.restoreAllMocks();
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function me(token: string) {
  return (await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status;
}

const unique = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
let ipCounter = 0;
/** A fresh IP per send, so the per-IP cap (5 an hour) never interferes between tests. */
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

async function codeFor(email: string) {
  await sendSignInCode(email, nextIp());
  return sent.filter((s) => s.to === email).at(-1)!.code;
}

describe("PWL: passwordless email", () => {
  it("PWL-001: a code goes to any address, with the same answer whether or not it has an account", async () => {
    const existing = await makeUser({ email: unique("known") });
    const known = await post("/auth/email/start", { email: existing.email });
    const unknown = await post("/auth/email/start", { email: unique("nobody") });
    expect(known.status).toBe(200);
    expect(unknown).toEqual(known);
    expect(await post("/auth/email/start", { email: "not-an-email" })).toMatchObject({ status: 400 });
    // The old sign-up endpoint still refuses an existing address (1.0 apps rely on that).
    expect((await post("/auth/send-otp", { email: existing.email })).status).toBe(409);
  });

  it("PWL-002: the right code signs an existing account in; a wrong one doesn't, and a code works once", async () => {
    const user = await makeUser({ email: unique("signin") });
    const code = await codeFor(user.email);

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    expect((await post("/auth/email/verify", { email: user.email, code: wrong })).status).toBe(400);

    const ok = await post("/auth/email/verify", { email: user.email, code });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("signedIn");
    expect(ok.json.user.id).toBe(user.id);
    expect(await me(ok.json.token)).toBe(200);

    expect((await post("/auth/email/verify", { email: user.email, code })).status).toBe(400);
  });

  it("PWL-003: five wrong codes burn it; the right one then fails too", async () => {
    const user = await makeUser({ email: unique("guess") });
    const code = await codeFor(user.email);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i++) await expect(verifyEmailCode(user.email, wrong)).rejects.toMatchObject({});
    await expect(verifyEmailCode(user.email, code)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("PWL-004: a new address gets a ticket, then an account with its name; the ticket is single-use", async () => {
    const email = unique("fresh");
    const code = await codeFor(email);

    const verified = await post("/auth/email/verify", { email, code });
    expect(verified.status).toBe(200);
    expect(verified.json.status).toBe("new");
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const ticket = verified.json.signupTicket as string;
    expect((await post("/auth/email/complete", { signupTicket: ticket, name: "   " })).status).toBe(400);
    const created = await post("/auth/email/complete", { signupTicket: ticket, name: "  New Person " });
    expect(created.status).toBe(201);
    expect(created.json.user).toMatchObject({ email, name: "New Person", hasPassword: false, openingBalance: null });
    expect(await me(created.json.token)).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { email }, include: { categories: true } });
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.passwordHash).toBeNull();
    expect(row.categories.length).toBeGreaterThan(0);

    // Replayed: the address has an account now.
    expect((await post("/auth/email/complete", { signupTicket: ticket, name: "Again" })).status).toBe(409);
  });

  it("PWL-005: a ticket isn't a session, a session isn't a ticket, and a forged ticket is refused", async () => {
    const email = unique("ticket");
    const verified = await verifyEmailCode(email, await codeFor(email));
    expect(verified.status).toBe("new");
    const ticket = (verified as { signupTicket: string }).signupTicket;

    expect(await me(ticket)).toBe(401);
    const user = await makeUser({ email: unique("session") });
    const session = signToken({ userId: user.id, tv: 0 });
    await expect(completeEmailSignUp(session, "X")).rejects.toMatchObject({ statusCode: 400 });
    await expect(completeEmailSignUp(`${ticket}x`, "X")).rejects.toMatchObject({ statusCode: 400 });
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("PWL-006: an account that never proved its address loses its password, and its old sessions end", async () => {
    // D-19/D-40: someone registered this address with a password before codes were required.
    const squatted = await prisma.user.create({
      data: { email: unique("squat"), name: "Squatter", passwordHash: await hashPassword("squatterpass") },
    });
    const squatterToken = signToken({ userId: squatted.id, tv: squatted.tokenVersion });
    expect(await me(squatterToken)).toBe(200);

    const result = await verifyEmailCode(squatted.email, await codeFor(squatted.email));
    expect(result.status).toBe("signedIn");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: squatted.id } });
    expect(after.passwordHash).toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await me(squatterToken)).toBe(401);
    expect(await me((result as { token: string }).token)).toBe(200);
    expect((await post("/auth/login", { email: squatted.email, password: "squatterpass" })).status).toBe(401);
  });

  it("PWL-007: a verified account keeps its password and sessions (the code doesn't reset anything)", async () => {
    const user = await prisma.user.create({
      data: { email: unique("verified"), name: "Owner", passwordHash: await hashPassword("ownerpass1"), emailVerifiedAt: new Date() },
    });
    const old = signToken({ userId: user.id, tv: user.tokenVersion });
    await verifyEmailCode(user.email, await codeFor(user.email));
    expect(await me(old)).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).not.toBeNull();
  });

  it("PWL-008: an unproved Google-linked account loses the link when the address owner proves it", async () => {
    // Created through Google for an address Google isn't authoritative for: unproved (D-66 review).
    const held = await prisma.user.create({
      data: { email: unique("corp"), name: "Former", googleId: `g-${Date.now()}` },
    });
    const formerToken = signToken({ userId: held.id, tv: held.tokenVersion });

    const result = await verifyEmailCode(held.email, await codeFor(held.email));
    expect(result.status).toBe("signedIn");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: held.id } });
    expect(after.googleId).toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await me(formerToken)).toBe(401);
  });
});

