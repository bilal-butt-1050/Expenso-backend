// Optional convenience script for local development: creates one demo
// account so you have something to log into immediately. Safe to run
// multiple times — it skips creation if the demo user already exists.
// Run with: npm run seed
import { prisma } from "../src/lib/prisma";
import { registerUser } from "../src/modules/auth/auth.service";

async function main() {
  const email = "demo@expenso.app";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Demo user already exists, skipping.");
    return;
  }

  await registerUser(email, "password123", "Demo User");
  console.log(`Created demo user: ${email} / password123`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
