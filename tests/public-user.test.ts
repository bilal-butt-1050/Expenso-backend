import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { getUserById, registerUser } from "../src/modules/auth/auth.service";

/** What the API says about the signed-in user. It never includes secrets. */
describe("public user", () => {
  it("includes when the account was created, and nothing secret", async () => {
    const before = Date.now();
    const { user } = await registerUser("created@example.com", "password123", "Created");

    const me = await getUserById(user.id);

    expect(typeof me.createdAt).toBe("string");
    expect(new Date(me.createdAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(user.createdAt).toBe(me.createdAt);
    for (const secret of ["passwordHash", "tokenVersion", "googleId", "emailVerifiedAt"]) {
      expect(me).not.toHaveProperty(secret);
    }
  });
});

describe("migration clear_borrowed_google_avatars", () => {
  const dir = readdirSync(join(__dirname, "../prisma/migrations")).find((d) => d.endsWith("_clear_borrowed_google_avatars"))!;
  const sql = readFileSync(join(__dirname, "../prisma/migrations", dir, "migration.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("clears a Google photo from password-only accounts and leaves every other picture alone", async () => {
    const { prisma } = await import("../src/lib/prisma");
    const photo = "https://lh3.googleusercontent.com/a/someone-elses-photo=s96-c";
    const borrowed = await prisma.user.create({ data: { email: "pw@example.com", passwordHash: "x", avatarUrl: photo } });
    const google = await prisma.user.create({ data: { email: "g@gmail.com", googleId: "g-1", avatarUrl: photo } });
    const own = await prisma.user.create({ data: { email: "own@example.com", passwordHash: "x", avatarUrl: "https://example.com/me.png" } });

    await prisma.$executeRawUnsafe(sql);
    await prisma.$executeRawUnsafe(sql); // idempotent

    expect((await prisma.user.findUniqueOrThrow({ where: { id: borrowed.id } })).avatarUrl).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: google.id } })).avatarUrl).toBe(photo);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: own.id } })).avatarUrl).toBe("https://example.com/me.png");
  });
});
