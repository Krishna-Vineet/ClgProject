import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { type DbClient, getDb } from "../../db/client";
import { departments, programs, studentProfiles } from "../../db/schema";
import { ApiError } from "../../utils/api-error";
import { type AuditContext, insertAudit } from "../audit/service";
import type { CreateDepartmentInput, createProgramSchema, updateProgramSchema } from "./schemas";

type Tx = Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0];

/**
 * Departments are reference data referenced by clubs, staff profiles, resources
 * and department-scoped role assignments. Reading is open to any authenticated
 * staff user because every picker needs it; writing is Admin-only.
 */
export async function listDepartments() {
  const { db } = getDb();
  const items = await db
    .select({ id: departments.id, code: departments.code, name: departments.name })
    .from(departments)
    .orderBy(asc(departments.name));
  return { items };
}

export async function createDepartment(input: CreateDepartmentInput, audit?: AuditContext) {
  const { db } = getDb();
  const [existing] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.code, input.code))
    .limit(1);
  if (existing) throw new ApiError("CONFLICT", "A department with that code already exists.");

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(departments).values(input).returning();
    if (!row) throw new ApiError("INTERNAL_ERROR", "Department creation failed.");
    if (audit)
      await insertAudit(tx, audit, {
        action: "DEPARTMENT_CREATED",
        entityType: "department",
        entityId: row.id,
        after: { code: row.code, name: row.name },
      });
    return row;
  });
}

export async function updateDepartment(
  id: string,
  input: { name?: string | undefined },
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(departments).where(eq(departments.id, id)).limit(1);
    if (!before) throw new ApiError("NOT_FOUND", "Department not found.");
    const [row] = await tx
      .update(departments)
      .set({ ...(input.name === undefined ? {} : { name: input.name }) })
      .where(eq(departments.id, id))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "DEPARTMENT_UPDATED",
        entityType: "department",
        entityId: id,
        before: { name: before.name },
        after: { name: row?.name },
      });
    return row;
  });
}

/**
 * Programmes carry their own department mapping and an optional foundation
 * window (first N years spent in another department). Registration and staff
 * edits both resolve the student's effective department through this rule, so
 * no programme names or year bands are hardcoded anywhere.
 */
export function effectiveDepartmentId(
  program: {
    departmentId: string | null;
    foundationDepartmentId: string | null;
    foundationYears: number;
  },
  studyYear: number | null,
) {
  if (
    program.foundationDepartmentId &&
    program.foundationYears > 0 &&
    studyYear !== null &&
    studyYear <= program.foundationYears
  )
    return program.foundationDepartmentId;
  return program.departmentId;
}

/** Recompute stored department membership for everyone in a programme. */
export async function recalcProgramPlacements(
  tx: Tx,
  program: {
    id: string;
    departmentId: string | null;
    foundationDepartmentId: string | null;
    foundationYears: number;
  },
) {
  const rows = await tx
    .select({
      userId: studentProfiles.userId,
      studyYear: studentProfiles.studyYear,
      departmentId: studentProfiles.departmentId,
    })
    .from(studentProfiles)
    .where(eq(studentProfiles.programId, program.id));
  for (const row of rows) {
    const next = effectiveDepartmentId(program, row.studyYear);
    if (next && next !== row.departmentId)
      await tx
        .update(studentProfiles)
        .set({ departmentId: next, updatedAt: new Date() })
        .where(eq(studentProfiles.userId, row.userId));
  }
}

export async function listPrograms(
  filters: { departmentId?: string | undefined; includeInactive?: boolean | undefined } = {},
) {
  const { db } = getDb();
  const rows = await db
    .select({
      id: programs.id,
      name: programs.name,
      departmentId: programs.departmentId,
      departmentName: departments.name,
      departmentCode: departments.code,
      foundationDepartmentId: programs.foundationDepartmentId,
      foundationYears: programs.foundationYears,
      durationYears: programs.durationYears,
      isActive: programs.isActive,
      students: sql<number>`(select count(*)::int from ${studentProfiles} sp where sp.program_id = ${programs.id})`,
    })
    .from(programs)
    .leftJoin(departments, eq(departments.id, programs.departmentId))
    .where(
      and(
        filters.includeInactive ? undefined : eq(programs.isActive, true),
        filters.departmentId ? eq(programs.departmentId, filters.departmentId) : undefined,
      ),
    )
    .orderBy(asc(programs.name));
  return { items: rows };
}

export async function createProgram(
  input: z.infer<typeof createProgramSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  if (input.foundationDepartmentId && input.foundationDepartmentId === input.departmentId)
    throw new ApiError(
      "VALIDATION_ERROR",
      "The foundation department must differ from the home department.",
    );
  try {
    return await db.transaction(async (tx) => {
      const ids = [input.departmentId, input.foundationDepartmentId].filter(
        (id): id is string => typeof id === "string",
      );
      const found = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(inArray(departments.id, ids));
      if (found.length !== ids.length)
        throw new ApiError("VALIDATION_ERROR", "Department not found.");
      const [row] = await tx
        .insert(programs)
        .values({
          name: input.name,
          departmentId: input.departmentId,
          foundationDepartmentId: input.foundationDepartmentId ?? null,
          foundationYears: input.foundationDepartmentId ? input.foundationYears : 0,
          durationYears: input.durationYears,
        })
        .returning();
      if (!row) throw new ApiError("INTERNAL_ERROR", "Programme creation failed.");
      if (audit)
        await insertAudit(tx, audit, {
          action: "PROGRAM_CREATED",
          entityType: "program",
          entityId: row.id,
          after: row,
        });
      return row;
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505")
      throw new ApiError("CONFLICT", "A programme with that name already exists.");
    throw error;
  }
}

export async function updateProgram(
  id: string,
  input: z.infer<typeof updateProgramSchema>,
  audit?: AuditContext,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(programs).where(eq(programs.id, id)).limit(1);
    if (!before) throw new ApiError("NOT_FOUND", "Programme not found.");
    const durationYears = input.durationYears ?? before.durationYears;
    const foundationYears = input.foundationYears ?? before.foundationYears;
    const homeDepartmentId = input.departmentId ?? before.departmentId;
    if (
      input.foundationDepartmentId &&
      homeDepartmentId &&
      input.foundationDepartmentId === homeDepartmentId
    )
      throw new ApiError(
        "VALIDATION_ERROR",
        "The foundation department must differ from the home department.",
      );
    if (foundationYears > durationYears)
      throw new ApiError("VALIDATION_ERROR", "Foundation years cannot exceed the duration.");
    for (const departmentId of [input.departmentId, input.foundationDepartmentId]) {
      if (!departmentId) continue;
      const [found] = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.id, departmentId))
        .limit(1);
      if (!found) throw new ApiError("VALIDATION_ERROR", "Department not found.");
    }
    const [row] = await tx
      .update(programs)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(programs.id, id))
      .returning();
    if (!row) throw new ApiError("INTERNAL_ERROR", "Programme update failed.");
    if (
      input.departmentId !== undefined ||
      input.foundationDepartmentId !== undefined ||
      input.foundationYears !== undefined
    )
      await recalcProgramPlacements(tx, row);
    if (audit)
      await insertAudit(tx, audit, {
        action: "PROGRAM_UPDATED",
        entityType: "program",
        entityId: id,
        before,
        after: row,
      });
    return row;
  });
}
