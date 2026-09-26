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
