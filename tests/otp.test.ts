import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { Prisma } from "@prisma/client";
import { generateAndSendOtp, consumeOtp, utc } from "../src/modules/auth/otp.service";
import { registerUser } from "../src/modules/auth/auth.service";

/**
 * Signup codes (ARCH N1/N3). Brevo is never called for real: `fetch` is stubbed, and the code is
 * read back from the email the stub was asked to send.
 */

const EMAIL = "new-user@example.com";
const IP = "203.0.113.7";

const saved = {
  nodeEnv: process.env.NODE_ENV,
  brevoApiKey: env.brevoApiKey,
  mailFromEmail: env.mailFromEmail,
  requireEmailVerification: env.requireEmailVerification,
};

let fetchSpy: MockInstance<typeof fetch>;
/** Every email the stub was asked to send, with the code pulled out of its HTML. */
let sent: { to: string; code: string }[];

function brevoResponds(status: number, body: object = {}) {
  fetchSpy.mockImplementation(async (_url, init) => {
    const payload = JSON.parse(String((init as RequestInit).body));
    // The code is the only content of the letter-spaced span. A bare six-digit match would also
    // pick up colours in the HTML, like #111827.
    const code = payload.htmlContent.match(/letter-spacing: 8px;[^>]*>(\d{6})</)[1];
    sent.push({ to: payload.to[0].email, code });
    return new Response(JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  env.brevoApiKey = "test-key";
  env.mailFromEmail = "codes@example.com";
  env.requireEmailVerification = false;
  sent = [];
  fetchSpy = vi.spyOn(globalThis, "fetch");
  brevoResponds(201, { messageId: "<m1>" });
});

afterEach(() => {
  process.env.NODE_ENV = saved.nodeEnv;
  env.brevoApiKey = saved.brevoApiKey;
  env.mailFromEmail = saved.mailFromEmail;
  env.requireEmailVerification = saved.requireEmailVerification;
  vi.restoreAllMocks();
});

/** A send-log row `minutesAgo` in the past, to set up the caps without waiting. */
async function logSend(email: string, ip: string, minutesAgo: number) {
  await prisma.otpSendLog.create({ data: { email, ip, createdAt: new Date(Date.now() - minutesAgo * 60_000) } });
}

const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e) => e.statusCode as number);

describe("EML: sending through Brevo", () => {
  it("EML-001: calls Brevo once with the right recipient, and stores only a hash of the code", async () => {
    const warn = vi.spyOn(console, "warn");
    process.env.NODE_ENV = "production";

    await generateAndSendOtp(EMAIL, IP);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init as RequestInit).headers).toMatchObject({ "api-key": "test-key" });
    expect(sent).toEqual([{ to: EMAIL, code: expect.stringMatching(/^\d{6}$/) }]);
    // Never logged in production, and not recoverable from the database.
    const code = sent[0].code;
    expect(warn.mock.calls.flat().join(" ")).not.toContain(code);
    const row = await prisma.otpVerification.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(row.otpHash).not.toContain(code);
    expect(row.otpHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [401, { code: "unauthorized", message: "unrecognised IP address" }, 503],
    [403, { code: "permission_denied", message: "account under validation" }, 503],
    [402, { code: "not_enough_credits", message: "no credits" }, 503],
    [429, { code: "too_many_requests", message: "slow down" }, 503],
    [400, { code: "invalid_parameter", message: "bad sender" }, 502],
    [500, { code: "internal", message: "boom" }, 502],
  ])("EML-002: Brevo %i maps to %i with a safe message and one log line", async (status, body, expected) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    brevoResponds(status, body);

    const err = await generateAndSendOtp(EMAIL, IP).catch((e) => e);

    expect(err.statusCode).toBe(expected);
    expect(err.message).not.toMatch(/brevo|unrecognised|credits|sender|IP/i);
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain(`[email] brevo ${status} ${body.code}`);
    expect(line).not.toContain("test-key");
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain(sent[0].code);
  });

  it("EML-002: a network failure maps to 502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    expect(await statusOf(generateAndSendOtp(EMAIL, IP))).toBe(502);
  });

  it("EML-003: without Brevo configured, the code is logged in development/test only", async () => {
    env.brevoApiKey = undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    process.env.NODE_ENV = "test";
    await generateAndSendOtp(EMAIL, IP);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/OTP for new-user@example\.com: \d{6}/);
    expect(fetchSpy).not.toHaveBeenCalled();

    for (const nodeEnv of ["production", undefined, "prod", "staging"]) {
      await prisma.otpSendLog.deleteMany();
      warn.mockClear();
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;

      expect(await statusOf(generateAndSendOtp(EMAIL, IP))).toBe(503);
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/\d{6}/);
    }
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/\d{6}/);
  });
});

describe("AUT: verifying codes", () => {
  async function sendAndReadCode(email = EMAIL) {
    await generateAndSendOtp(email, IP);
    return sent[sent.length - 1].code;
  }

  it("AUT-001: with verification required, registering without a code is refused", async () => {
    env.requireEmailVerification = true;
    expect(await statusOf(registerUser(EMAIL, "password123", "New"))).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  it("AUT-002: a valid code registers the user, marks the email verified, and is consumed", async () => {
    env.requireEmailVerification = true;
    const code = await sendAndReadCode();

    const { user } = await registerUser(EMAIL, "password123", "New", code);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await prisma.otpVerification.count({ where: { email: EMAIL } })).toBe(0);
  });

  it("without a code and verification off, registration works but the email stays unverified", async () => {
    const { user } = await registerUser(EMAIL, "password123", "New");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
  });

  it("AUT-003: a consumed code can't be used again", async () => {
    const code = await sendAndReadCode();
    await consumeOtp(EMAIL, code);
    expect(await statusOf(consumeOtp(EMAIL, code))).toBe(400);
  });

  it("AUT-004: an expired code is refused and deleted", async () => {
    const code = await sendAndReadCode();
    await prisma.otpVerification.update({ where: { email: EMAIL }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const err = await consumeOtp(EMAIL, code).catch((e) => e);

    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/expired/);
    expect(await prisma.otpVerification.count({ where: { email: EMAIL } })).toBe(0);
  });

  it("expiry is compared in UTC whatever the database session's time zone", async () => {
    // One transaction = one connection, so SET LOCAL really applies to the queries below.
    const expiresAt = new Date(Date.now() + 60_000);
    const [viaUtc, viaNow] = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Karachi'`);
      const a = await tx.$queryRaw<{ ok: boolean }[]>(
        Prisma.sql`SELECT ${utc(expiresAt)} > ${utc(new Date())} AS ok`
      );
      // What a naive comparison against now() would do: in +05 it's five hours ahead.
      const b = await tx.$queryRaw<{ ok: boolean }[]>(
        Prisma.sql`SELECT ${utc(expiresAt)} > now()::timestamp AS ok`
      );
      return [a[0].ok, b[0].ok];
    });
    expect(viaUtc).toBe(true);
    expect(viaNow).toBe(false);
  });

  it("AUT-005: five wrong codes burn it; even the right code then fails", async () => {
    const code = await sendAndReadCode();
    const wrong = code === "111111" ? "222222" : "111111";

    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await statusOf(consumeOtp(EMAIL, wrong)));

    expect(statuses).toEqual([400, 400, 400, 400, 429]);
    expect(await statusOf(consumeOtp(EMAIL, code))).toBe(429);
  });

  it("AUT-024: 20 concurrent wrong guesses evaluate at most 5", async () => {
    const code = await sendAndReadCode();
    const wrong = code === "111111" ? "222222" : "111111";

    const statuses = await Promise.all(Array.from({ length: 20 }, () => statusOf(consumeOtp(EMAIL, wrong))));

    const row = await prisma.otpVerification.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(row.attempts).toBe(5);
    expect(statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(4);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(16);
    expect(await statusOf(consumeOtp(EMAIL, code))).toBe(429);
  });

  it("two concurrent correct submissions consume the code exactly once", async () => {
    const code = await sendAndReadCode();
    const statuses = await Promise.all([statusOf(consumeOtp(EMAIL, code)), statusOf(consumeOtp(EMAIL, code))]);
    expect(statuses.sort()).toEqual([200, 400]);
  });
});

describe("AUT: send caps", () => {
  it("AUT-006: a resend inside 60 seconds is refused", async () => {
    await generateAndSendOtp(EMAIL, IP);
    const err = await generateAndSendOtp(EMAIL, IP).catch((e) => e);
    expect(err.statusCode).toBe(429);
    expect(err.message).toMatch(/Please wait \d+s/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("AUT-025: over 5 codes to one email in 24 h → 429", async () => {
    for (const minutes of [60, 120, 180, 240, 300]) await logSend(EMAIL, "198.51.100.1", minutes);
    const err = await generateAndSendOtp(EMAIL, IP).catch((e) => e);
    expect(err.statusCode).toBe(429);
    expect(err.message).toMatch(/tomorrow/);
  });

  it("AUT-025: sends older than 24 h don't count toward the per-email cap", async () => {
    for (let i = 0; i < 5; i++) await logSend(EMAIL, "198.51.100.1", 25 * 60 + i);
    await expect(generateAndSendOtp(EMAIL, IP)).resolves.toBeUndefined();
  });

  it("AUT-025: over 5 codes from one IP in an hour → 429", async () => {
    for (let i = 0; i < 5; i++) await logSend(`other${i}@example.com`, IP, 5 + i);
    expect(await statusOf(generateAndSendOtp(EMAIL, IP))).toBe(429);
  });

  it("AUT-025: over the global daily budget → 503, and Brevo is never called", async () => {
    await prisma.otpSendLog.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        email: `bulk${i}@example.com`,
        ip: `198.51.100.${i % 250}`,
        createdAt: new Date(Date.now() - 2 * 60 * 60_000),
      })),
    });
    expect(await statusOf(generateAndSendOtp(EMAIL, IP))).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("concurrent sends to one email: exactly one goes out (the advisory lock)", async () => {
    const statuses = await Promise.all(Array.from({ length: 10 }, () => statusOf(generateAndSendOtp(EMAIL, IP))));
    expect(statuses.filter((st) => st === 200)).toHaveLength(1);
    expect(statuses.filter((st) => st === 429)).toHaveLength(9);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await prisma.otpSendLog.count()).toBe(1);
  });

  it("concurrent sends from one IP never exceed the per-IP cap", async () => {
    const statuses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => statusOf(generateAndSendOtp(`burst${i}@example.com`, IP)))
    );
    expect(statuses.filter((st) => st === 200)).toHaveLength(5);
    expect(await prisma.otpSendLog.count({ where: { ip: IP } })).toBe(5);
  });

  it("a failed send still counts toward the caps", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    brevoResponds(500, { code: "internal" });
    expect(await statusOf(generateAndSendOtp(EMAIL, IP))).toBe(502);
    expect(await prisma.otpSendLog.count({ where: { email: EMAIL } })).toBe(1);
  });

  it("an existing account gets 409 and nothing is sent", async () => {
    await registerUser(EMAIL, "password123", "Existing");
    expect(await statusOf(generateAndSendOtp(EMAIL, IP))).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
