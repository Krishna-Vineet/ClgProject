/**
 * One-time production bootstrap: create the FIRST Admin (Principal) account.
 * Refuses to run if any ADMIN already exists, so it cannot be used to
 * silently add more administrators. Run from a trusted machine with the
 * production DATABASE_URL and BOOTSTRAP_ADMIN_* variables set:
 *
 *   BOOTSTRAP_ADMIN_EMAIL=principal@college.edu \
 *   BOOTSTRAP_ADMIN_NAME="Dr. A. Principal" \
 *   BOOTSTRAP_ADMIN_PASSWORD='<strong temporary password>' \
 *   bun run admin:bootstrap
 *
 * Only DATABASE_URL is required (no JWT/email/S3 secrets). The account is
 * created ACTIVE with a verified email and must change its password after
 * first sign-in. Nothing here is a demo account.
 */
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "../utils/password";
import { closeDb, createDb } from "./client";
import { roleAssignments, staffProfiles, users } from "./schema";

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(128),
});

async function bootstrapAdmin() {
  const input = inputSchema.parse({
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    name: process.env.BOOTSTRAP_ADMIN_NAME,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for admin bootstrap.");

  const { db, sql } = createDb(url, 1);
  try {
    const [admins] = await db
      .select({ n: count() })
      .from(roleAssignments)
      .where(eq(roleAssignments.role, "ADMIN"));
    if ((admins?.n ?? 0) > 0) {
      throw new Error(
        "An ADMIN role already exists. Bootstrap refused; use the Administration panel instead.",
      );
    }
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing) {
      throw new Error(
        "A user with that email already exists. Use the Administration panel to grant roles.",
      );
    }
    const hash = await hashPassword(input.password);
    await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          fullName: input.name,
          passwordHash: hash,
          accountType: "STAFF",
          status: "ACTIVE",
          emailVerifiedAt: new Date(),
        })
        .returning();
      if (!user) throw new Error("insert failed");
      await tx
        .insert(staffProfiles)
        .values({ userId: user.id, designation: "Principal", position: "OTHER" });
      await tx
        .insert(roleAssignments)
        .values({ userId: user.id, role: "ADMIN", scopeType: "GLOBAL" });
    });
    console.log(
      `Bootstrap complete: ${input.email} is now the institution Admin. Sign in and change the password immediately.`,
    );
  } finally {
    await closeDb({ db, sql });
  }
}

bootstrapAdmin().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Bootstrap refused: ${message.split("\n")[0]}`);
  process.exitCode = 1;
});
