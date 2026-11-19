import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../db/client";
import { clubMemberships, clubs, roleAssignments, studentProfiles, users } from "../../db/schema";
import {
  type AuthContext,
  authenticate,
  departmentScope,
  hasRole,
  requireActiveAccount,
} from "../../middleware/auth";
import { parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";
import { myManagedEvents } from "../events/service";
import { listVisibleEvents } from "../events/visibility";

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

const ROLE_ORDER = ["Admin", "HOD", "Faculty", "Coordinator", "Student", "Outsider", "Staff"];

function roleRank(role: string) {
  const index = ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

/**
 * Who may this person find in the console search?
 *
 * The rule is "whoever you can open a profile for", and it has to be the same
 * rule the destination pages use — otherwise search says "no such student" about
 * someone the Students page lists two clicks away. That was the HOD's complaint.
 *
 *   Admin        everyone.
 *   HOD/Dean     their department(s): students in them, plus any staff account.
 *   Faculty      students in the departments they are scoped to (they can open a
 *                student profile), plus themselves.
 *   Anyone else  no people results. A club lead searches events and clubs; a
 *                student has no business enumerating classmates from here.
 */
async function searchablePeople(
  auth: AuthContext,
  needle: string,
  limit: number,
): Promise<
  Array<{ id: string; fullName: string; email: string; accountType: string; status: string }>
> {
  const { db } = getDb();
  const byName = or(ilike(users.fullName, needle), ilike(users.email, needle));
  if (hasRole(auth, "ADMIN")) {
    return db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        accountType: users.accountType,
        status: users.status,
      })
      .from(users)
      .where(byName)
      .orderBy(users.fullName)
      .limit(limit);
  }

  const isHod = hasRole(auth, "HOD_DEAN");
  const isFaculty = hasRole(auth, "FACULTY");
  if (!isHod && !isFaculty) return [];

  const scope = departmentScope(auth, isHod ? "HOD_DEAN" : "FACULTY");
  if (scope.global) {
    return db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        accountType: users.accountType,
        status: users.status,
      })
      .from(users)
      .where(byName)
      .orderBy(users.fullName)
      .limit(limit);
  }

  // Students are scoped by department; staff accounts are not in a department at
  // all, so a departmental reviewer still finds the faculty they work with.
  const conditions = [sql`${users.accountType} <> 'COLLEGE_STUDENT'`];
  if (scope.departmentIds.length) {
    conditions.push(
      sql`exists (
        select 1 from ${studentProfiles}
        where ${studentProfiles.userId} = ${users.id}
          and ${inArray(studentProfiles.departmentId, scope.departmentIds)}
      )`,
    );
  }
  return db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      accountType: users.accountType,
      status: users.status,
    })
    .from(users)
    .where(and(byName, or(...conditions)))
    .orderBy(users.fullName)
    .limit(limit);
}

/**
 * One search box for the console. Events follow the same management scope as
 * the Events page: Admin sees everything, an HOD/Dean sees their departments,
 * and club members see their clubs — drafts included.
 */
export const searchRoutes = new Hono();
searchRoutes.use("*", authenticate, requireActiveAccount);
searchRoutes.get("/", async (c) => {
  const { q, limit } = parseQuery(c, searchQuerySchema);
  const auth = c.get("auth");
  const { db } = getDb();
  const needle = `%${q}%`;

  const managesEvents =
    hasRole(auth, "ADMIN") || hasRole(auth, "HOD_DEAN") || auth.memberships.length > 0;
  // Managed events carry every status, drafts included. Published events the
  // caller may simply attend are merged in so global search still discovers
  // them; the dedupe keeps a club's own event from appearing twice.
  const [managedPage, visiblePage] = await Promise.all([
    managesEvents ? myManagedEvents(auth, { limit, offset: 0, q }) : Promise.resolve(null),
    listVisibleEvents(auth, { limit, offset: 0, q }),
  ]);
  const eventItems = [...(managedPage?.items ?? []), ...visiblePage.items]
    .filter((event, index, all) => all.findIndex((other) => other.id === event.id) === index)
    .slice(0, limit);
  const memberClubIds = auth.memberships.map((m) => m.clubId);
  const seesAllClubs =
    hasRole(auth, "ADMIN") || hasRole(auth, "HOD_DEAN") || hasRole(auth, "FACULTY");
  const clubRows =
    seesAllClubs || memberClubIds.length
      ? await db
          .select({
            id: clubs.id,
            name: clubs.name,
            slug: clubs.slug,
            description: clubs.description,
          })
          .from(clubs)
          .where(
            seesAllClubs
              ? ilike(clubs.name, needle)
              : and(ilike(clubs.name, needle), inArray(clubs.id, memberClubIds)),
          )
          .limit(limit)
      : [];

  const peopleRows = await searchablePeople(auth, needle, limit);
  const peopleIds = peopleRows.map((p) => p.id);
  const [staffRoles, clubRoles] = peopleIds.length
    ? await Promise.all([
        db
          .select({ userId: roleAssignments.userId, role: roleAssignments.role })
          .from(roleAssignments)
          .where(
            and(inArray(roleAssignments.userId, peopleIds), eq(roleAssignments.isActive, true)),
          ),
        db
          .select({ userId: clubMemberships.userId, role: clubMemberships.clubRole })
          .from(clubMemberships)
          .where(
            and(inArray(clubMemberships.userId, peopleIds), eq(clubMemberships.isActive, true)),
          ),
      ])
    : [[], []];
  const roleSets = new Map<string, Set<string>>();
  const addRole = (userId: string, role: string) => {
    const set = roleSets.get(userId) ?? new Set<string>();
    set.add(role);
    roleSets.set(userId, set);
  };
  for (const row of staffRoles) {
    addRole(
      row.userId,
      row.role === "ADMIN"
        ? "Admin"
        : row.role === "HOD_DEAN"
          ? "HOD"
          : row.role === "FACULTY"
            ? "Faculty"
            : "Staff",
    );
  }
  for (const row of clubRoles)
    if (row.role === "LEAD" || row.role === "COORDINATOR") addRole(row.userId, "Coordinator");
  const people = peopleRows.map((person) => {
    const roles = [...(roleSets.get(person.id) ?? [])];
    if (person.accountType === "OUTSIDER_STUDENT") roles.push("Outsider");
    else if (person.accountType === "COLLEGE_STUDENT") roles.push("Student");
    else if (roles.length === 0) roles.push("Staff");
    const ordered = [...new Set(roles)].sort((a, b) => roleRank(a) - roleRank(b));
    return { ...person, role: ordered[0] ?? "Staff", roles: ordered };
  });

  return ok(c, {
    query: q,
    events: eventItems.map((e) => ({
      id: e.id,
      title: e.title,
      status: e.status,
      startsAt: e.startsAt,
      venueSummary: e.venueSummary,
    })),
    clubs: clubRows,
    people,
  });
});
