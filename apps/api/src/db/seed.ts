import { sql } from "drizzle-orm";
import { readEnv } from "../config/env";
import { hashPassword } from "../utils/password";
import { closeDb, createDb } from "./client";
import * as s from "./schema";

/**
 * Idempotent demo seed.
 * - Fixed UUIDs make repeated runs safe.
 * - No real student data.
 * - Password hashes are disabled placeholders by default.
 * - For local demos only, set SEED_DEMO_PASSWORD to enable login for demo accounts.
 */

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NO_LOGIN = "SEED_ONLY_NO_LOGIN";
const now = new Date();
const future = (days: number, hour = 9) => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

async function main() {
  const env = readEnv();
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for seeding.");
  const { db, sql: client } = createDb(env.DATABASE_URL, 1);
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(s.departments)
        .values([
          { id: U(1), code: "CSE", name: "Computer Science & Engineering" },
          { id: U(2), code: "ECE", name: "Electronics & Communication" },
          { id: U(3), code: "SCI", name: "Applied Science" },
          { id: U(4), code: "MGT", name: "Management Studies" },
        ])
        .onConflictDoNothing();

      // Programmes carry their department mapping and, where configured, the
      // foundation years spent in Applied Science. This is demo data, not a
      // code rule: administrators can change or remove it.
      await tx
        .insert(s.programs)
        .values([
          {
            id: U(40),
            name: "B.Tech Computer Science",
            departmentId: U(1),
            foundationDepartmentId: U(3),
            foundationYears: 1,
            durationYears: 4,
          },
          {
            id: U(41),
            name: "B.Tech Electronics",
            departmentId: U(2),
            foundationDepartmentId: U(3),
            foundationYears: 1,
            durationYears: 4,
          },
          {
            id: U(42),
            name: "BBA",
            departmentId: U(4),
            durationYears: 3,
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.users)
        .values([
          {
            id: U(10),
            email: "principal@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "STAFF",
            status: "ACTIVE",
            fullName: "Demo Principal",
            phone: "+91 98100 00010",
            emailVerifiedAt: now,
          },
          {
            id: U(11),
            email: "hoddean.cse@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "STAFF",
            status: "ACTIVE",
            fullName: "Demo HOD/Dean",
            phone: "+91 98100 00011",
            emailVerifiedAt: now,
          },
          {
            id: U(12),
            email: "faculty.cse@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "STAFF",
            status: "ACTIVE",
            fullName: "Demo Faculty CSE",
            phone: "+91 98100 00012",
            emailVerifiedAt: now,
          },
          {
            id: U(13),
            email: "faculty.ece@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "STAFF",
            status: "ACTIVE",
            fullName: "Demo Faculty ECE",
            emailVerifiedAt: now,
          },
          {
            id: U(14),
            email: "coding.lead@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "COLLEGE_STUDENT",
            status: "ACTIVE",
            fullName: "Demo Coding Lead",
            emailVerifiedAt: now,
          },
          {
            id: U(15),
            email: "robotics.coordinator@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "COLLEGE_STUDENT",
            status: "ACTIVE",
            fullName: "Demo Robotics Coordinator",
            emailVerifiedAt: now,
          },
          {
            id: U(16),
            email: "student.verified@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "COLLEGE_STUDENT",
            status: "ACTIVE",
            fullName: "Demo Verified Student",
            emailVerifiedAt: now,
          },
          {
            id: U(17),
            email: "student.pending@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "COLLEGE_STUDENT",
            status: "PENDING_VERIFICATION",
            fullName: "Demo Pending Student",
          },
          {
            id: U(18),
            email: "outsider@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "OUTSIDER_STUDENT",
            status: "ACTIVE",
            fullName: "Demo Outsider",
            emailVerifiedAt: now,
          },
          {
            id: U(21),
            email: "rahul@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "COLLEGE_STUDENT",
            status: "ACTIVE",
            fullName: "Demo Rahul Verma",
            emailVerifiedAt: now,
          },
          {
            id: U(22),
            email: "meera@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "COLLEGE_STUDENT",
            status: "ACTIVE",
            fullName: "Demo Meera Nair",
            emailVerifiedAt: now,
          },
          {
            id: U(23),
            email: "arjun@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "COLLEGE_STUDENT",
            status: "ACTIVE",
            fullName: "Demo Arjun Rao",
            emailVerifiedAt: now,
          },
          {
            id: U(20),
            email: "support@demo.campusops.local",
            passwordHash: NO_LOGIN,
            accountType: "STAFF",
            status: "ACTIVE",
            fullName: "Demo Support",
            emailVerifiedAt: now,
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.staffProfiles)
        .values([
          {
            userId: U(10),
            employeeCode: "DEMO-ADM-001",
            designation: "Principal",
            position: "OTHER",
          },
          {
            userId: U(11),
            employeeCode: "DEMO-HOD-001",
            departmentId: U(1),
            designation: "HOD/Dean",
            position: "HOD",
          },
          {
            userId: U(12),
            employeeCode: "DEMO-FAC-001",
            departmentId: U(1),
            designation: "Faculty",
            position: "PROFESSOR",
          },
          {
            userId: U(13),
            employeeCode: "DEMO-FAC-002",
            departmentId: U(2),
            designation: "Faculty",
            position: "PROFESSOR",
          },
          {
            userId: U(20),
            employeeCode: "DEMO-SUP-001",
            designation: "IT Support",
            position: "OTHER",
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.studentProfiles)
        .values([
          {
            userId: U(14),
            studentKind: "COLLEGE_STUDENT",
            institutionName: "Demo Institute of Technology",
            rollNumber: "DEMO-CSE-001",
            departmentId: U(1),
            program: "B.Tech CSE",
            graduationYear: 2027,
            verifiedBy: U(12),
            verifiedAt: now,
          },
          {
            userId: U(15),
            studentKind: "COLLEGE_STUDENT",
            institutionName: "Demo Institute of Technology",
            rollNumber: "DEMO-ECE-001",
            departmentId: U(2),
            program: "B.Tech ECE",
            graduationYear: 2027,
            verifiedBy: U(13),
            verifiedAt: now,
          },
          {
            userId: U(16),
            studentKind: "COLLEGE_STUDENT",
            institutionName: "Demo Institute of Technology",
            rollNumber: "DEMO-CSE-002",
            departmentId: U(1),
            program: "B.Tech CSE",
            graduationYear: 2028,
            verifiedBy: U(12),
            verifiedAt: now,
          },
          {
            userId: U(17),
            studentKind: "COLLEGE_STUDENT",
            institutionName: "Demo Institute of Technology",
            rollNumber: "DEMO-CSE-003",
            departmentId: U(1),
            program: "B.Tech CSE",
            graduationYear: 2028,
          },
          {
            userId: U(21),
            studentKind: "COLLEGE_STUDENT",
            institutionName: "Demo Institute of Technology",
            rollNumber: "DEMO-CSE-021",
            departmentId: U(1),
            program: "B.Tech CSE",
            graduationYear: 2027,
            verifiedBy: U(12),
            verifiedAt: now,
          },
          {
            userId: U(22),
            studentKind: "COLLEGE_STUDENT",
            institutionName: "Demo Institute of Technology",
            rollNumber: "DEMO-CSE-022",
            departmentId: U(1),
            program: "B.Tech CSE",
            graduationYear: 2027,
            verifiedBy: U(12),
            verifiedAt: now,
          },
          {
            userId: U(23),
            studentKind: "COLLEGE_STUDENT",
            institutionName: "Demo Institute of Technology",
            rollNumber: "DEMO-ECE-023",
            departmentId: U(2),
            program: "B.Tech ECE",
            graduationYear: 2028,
            verifiedBy: U(13),
            verifiedAt: now,
          },
          {
            userId: U(18),
            studentKind: "OUTSIDER_STUDENT",
            institutionName: "Demo City College",
            program: "B.Sc CS",
            graduationYear: 2027,
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.roleAssignments)
        .values([
          { id: U(30), userId: U(10), role: "ADMIN", scopeType: "GLOBAL", grantedBy: U(10) },
          {
            id: U(31),
            userId: U(11),
            role: "HOD_DEAN",
            scopeType: "DEPARTMENT",
            departmentId: U(1),
            grantedBy: U(10),
          },
          {
            id: U(32),
            userId: U(12),
            role: "FACULTY",
            scopeType: "DEPARTMENT",
            departmentId: U(1),
            grantedBy: U(10),
          },
          {
            id: U(33),
            userId: U(13),
            role: "FACULTY",
            scopeType: "DEPARTMENT",
            departmentId: U(2),
            grantedBy: U(10),
          },
          { id: U(34), userId: U(20), role: "SUPPORT", scopeType: "GLOBAL", grantedBy: U(10) },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.clubs)
        .values([
          {
            id: U(40),
            name: "Demo Coding Club",
            slug: "demo-coding-club",
            departmentId: U(1),
            createdBy: U(10),
          },
          {
            id: U(41),
            name: "Demo Robotics Club",
            slug: "demo-robotics-club",
            departmentId: U(2),
            createdBy: U(10),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.clubMemberships)
        .values([
          { id: U(50), clubId: U(40), userId: U(14), clubRole: "LEAD", addedBy: U(10) },
          { id: U(51), clubId: U(41), userId: U(15), clubRole: "COORDINATOR", addedBy: U(10) },
          { id: U(52), clubId: U(40), userId: U(15), clubRole: "COORDINATOR", addedBy: U(10) },
          // Club faculty: organise, approve and scan. There is no advisor role.
          { id: U(53), clubId: U(40), userId: U(12), clubRole: "FACULTY", addedBy: U(10) },
          { id: U(54), clubId: U(41), userId: U(13), clubRole: "FACULTY", addedBy: U(10) },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.resources)
        .values([
          {
            id: U(60),
            kind: "VENUE",
            name: "Main Auditorium",
            code: "DEMO-AUD",
            capacity: 300,
            createdBy: U(10),
          },
          {
            id: U(61),
            kind: "LAB",
            name: "Computer Lab 2",
            code: "DEMO-LAB2",
            departmentId: U(1),
            capacity: 60,
            createdBy: U(11),
          },
          {
            id: U(62),
            kind: "EQUIPMENT",
            name: "Portable Projector",
            code: "DEMO-PROJ",
            createdBy: U(11),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.resourceUnits)
        .values([
          { id: U(70), resourceId: U(60), label: "Auditorium Hall", code: "DEMO-AUD-01" },
          { id: U(71), resourceId: U(61), label: "Lab 2 Room", code: "DEMO-LAB2-01" },
          { id: U(72), resourceId: U(62), label: "Projector 01", code: "DEMO-PROJ-01" },
          { id: U(73), resourceId: U(62), label: "Projector 02", code: "DEMO-PROJ-02" },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.events)
        .values([
          {
            id: U(80),
            clubId: U(40),
            createdBy: U(14),
            title: "Intro to Git Workshop",
            slug: "demo-git-workshop",
            description: "Demo FCFS workshop.",
            template: "WORKSHOP",
            status: "PUBLISHED",
            audience: "COLLEGE_ONLY",
            admissionMode: "FCFS",
            capacity: 60,
            startsAt: future(7, 9),
            endsAt: future(7, 11),
            registrationOpensAt: future(-1, 0),
            registrationClosesAt: future(7, 8),
            venueSummary: "Computer Lab 2",
            publishedAt: now,
          },
          {
            id: U(81),
            clubId: U(40),
            createdBy: U(14),
            title: "AI Seminar",
            slug: "demo-ai-seminar",
            description: "Demo manual-admission seminar.",
            template: "SEMINAR",
            status: "PUBLISHED",
            audience: "OUTSIDERS_ALLOWED",
            admissionMode: "MANUAL",
            capacity: 120,
            startsAt: future(10, 14),
            endsAt: future(10, 16),
            registrationOpensAt: future(-1, 0),
            registrationClosesAt: future(10, 13),
            venueSummary: "Main Auditorium",
            publishedAt: now,
          },
          {
            id: U(82),
            clubId: U(41),
            createdBy: U(15),
            title: "Debugging Contest",
            slug: "demo-debugging-contest",
            description: "Demo event with individual pending approvals.",
            template: "HACKATHON",
            status: "PENDING_APPROVALS",
            audience: "COLLEGE_ONLY",
            admissionMode: "MANUAL",
            capacity: 40,
            startsAt: future(14, 10),
            endsAt: future(14, 13),
            registrationOpensAt: future(1, 0),
            registrationClosesAt: future(14, 9),
            venueSummary: "Computer Lab 2",
            submittedAt: now,
          },
          {
            // A finished event so the Reports area has a real record to show.
            id: U(83),
            clubId: U(40),
            createdBy: U(14),
            title: "Applied ML Recap Session",
            slug: "demo-applied-ml-recap",
            description:
              "Demo completed session: hands-on model evaluation, followed by participant presentations.",
            template: "WORKSHOP",
            status: "COMPLETED",
            audience: "COLLEGE_ONLY",
            admissionMode: "FCFS",
            capacity: 60,
            startsAt: future(-6, 10),
            endsAt: future(-6, 13),
            registrationOpensAt: future(-14, 9),
            registrationClosesAt: future(-6, 10),
            venueSummary: "Computer Lab 2",
            publishedAt: future(-12, 9),
            submittedAt: future(-13, 9),
            completedAt: future(-6, 13),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.eventRevisions)
        .values([
          {
            id: U(90),
            eventId: U(80),
            revision: 1,
            snapshot: { title: "Intro to Git Workshop", capacity: 60 },
            createdBy: U(14),
          },
          {
            id: U(91),
            eventId: U(81),
            revision: 1,
            snapshot: { title: "AI Seminar", capacity: 120 },
            createdBy: U(14),
          },
          {
            id: U(92),
            eventId: U(82),
            revision: 1,
            snapshot: { title: "Debugging Contest", capacity: 40 },
            createdBy: U(15),
          },
          {
            id: U(93),
            eventId: U(83),
            revision: 1,
            snapshot: { title: "Applied ML Recap Session", capacity: 60 },
            createdBy: U(14),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.approvalBundles)
        .values([
          { id: U(100), eventId: U(80), eventRevisionId: U(90), submittedBy: U(14) },
          { id: U(101), eventId: U(81), eventRevisionId: U(91), submittedBy: U(14) },
          { id: U(102), eventId: U(82), eventRevisionId: U(92), submittedBy: U(15) },
          {
            id: U(103),
            eventId: U(83),
            eventRevisionId: U(93),
            submittedBy: U(14),
            createdAt: future(-13, 9),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.approvalRequests)
        .values([
          {
            id: U(110),
            bundleId: U(100),
            type: "ORGANIZE",
            title: "Organize Git Workshop",
            currentTier: "FACULTY",
            assignedApproverId: U(12),
            status: "APPROVED",
            createdBy: U(14),
            decidedAt: now,
            decidedBy: U(12),
          },
          {
            id: U(111),
            bundleId: U(100),
            type: "RESOURCE_USE",
            title: "Use Computer Lab 2",
            currentTier: "FACULTY",
            assignedApproverId: U(12),
            status: "APPROVED",
            createdBy: U(14),
            decidedAt: now,
            decidedBy: U(12),
          },
          {
            id: U(112),
            bundleId: U(101),
            type: "ORGANIZE",
            title: "Organize AI Seminar",
            currentTier: "FACULTY",
            assignedApproverId: U(12),
            status: "APPROVED",
            createdBy: U(14),
            decidedAt: now,
            decidedBy: U(12),
          },
          {
            id: U(113),
            bundleId: U(101),
            type: "INVITE_OUTSIDERS",
            title: "Invite outsider students",
            currentTier: "SENIOR",
            assignedApproverId: U(11),
            status: "APPROVED",
            createdBy: U(14),
            decidedAt: now,
            decidedBy: U(11),
          },
          {
            id: U(114),
            bundleId: U(102),
            type: "ORGANIZE",
            title: "Organize Debugging Contest",
            currentTier: "FACULTY",
            assignedApproverId: U(13),
            status: "PENDING",
            createdBy: U(15),
          },
          {
            id: U(115),
            bundleId: U(102),
            type: "RESOURCE_USE",
            title: "Use Lab 2 for 3 hours",
            currentTier: "FACULTY",
            assignedApproverId: U(12),
            status: "PENDING",
            createdBy: U(15),
          },
          {
            id: U(116),
            bundleId: U(102),
            type: "RESOURCE_USE",
            title: "Use Projector 01",
            currentTier: "FACULTY",
            assignedApproverId: U(12),
            status: "PENDING",
            createdBy: U(15),
          },
          {
            id: U(117),
            bundleId: U(102),
            type: "CUSTOM",
            title: "Overnight refreshments",
            isRequired: false,
            currentTier: "SENIOR",
            assignedApproverId: U(11),
            status: "PENDING",
            createdBy: U(15),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.approvalRequests)
        .values([
          {
            id: U(118),
            bundleId: U(103),
            type: "ORGANIZE",
            title: "Organize the Applied ML recap",
            currentTier: "SENIOR",
            status: "APPROVED",
            createdBy: U(14),
            decidedAt: future(-12, 11),
            decidedBy: U(11),
            createdAt: future(-13, 9),
          },
          {
            id: U(119),
            bundleId: U(103),
            type: "RESOURCE_USE",
            title: "Use Computer Lab 2 and a projector",
            currentTier: "FACULTY",
            assignedApproverId: U(12),
            status: "APPROVED",
            createdBy: U(14),
            decidedAt: future(-12, 10),
            decidedBy: U(12),
            createdAt: future(-13, 9),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.approvalActions)
        .values([
          {
            id: U(126),
            requestId: U(118),
            actorId: U(14),
            action: "SUBMIT",
            toTier: "FACULTY",
            toStatus: "PENDING",
            requestVersion: 1,
            createdAt: future(-13, 9),
          },
          {
            id: U(127),
            requestId: U(118),
            actorId: U(12),
            action: "ESCALATE",
            fromTier: "FACULTY",
            toTier: "SENIOR",
            fromStatus: "PENDING",
            toStatus: "PENDING",
            requestVersion: 1,
            comment: "Lab usage needs departmental sign-off.",
            createdAt: future(-13, 12),
          },
          {
            id: U(128),
            requestId: U(118),
            actorId: U(11),
            action: "APPROVE",
            fromTier: "SENIOR",
            toTier: "SENIOR",
            fromStatus: "PENDING",
            toStatus: "APPROVED",
            requestVersion: 2,
            comment: "Approved. Restore the lab inventory afterwards.",
            createdAt: future(-12, 11),
          },
          {
            id: U(129),
            requestId: U(119),
            actorId: U(14),
            action: "SUBMIT",
            toTier: "FACULTY",
            toStatus: "PENDING",
            requestVersion: 1,
            createdAt: future(-13, 9),
          },
          {
            id: U(133),
            requestId: U(119),
            actorId: U(12),
            action: "APPROVE",
            fromTier: "FACULTY",
            toTier: "FACULTY",
            fromStatus: "PENDING",
            toStatus: "APPROVED",
            requestVersion: 1,
            createdAt: future(-12, 10),
          },
          {
            id: U(120),
            requestId: U(110),
            actorId: U(14),
            action: "SUBMIT",
            toTier: "FACULTY",
            toStatus: "PENDING",
            requestVersion: 1,
          },
          {
            id: U(121),
            requestId: U(110),
            actorId: U(12),
            action: "APPROVE",
            fromTier: "FACULTY",
            toTier: "FACULTY",
            fromStatus: "PENDING",
            toStatus: "APPROVED",
            requestVersion: 1,
          },
          {
            id: U(122),
            requestId: U(113),
            actorId: U(12),
            action: "ESCALATE",
            fromTier: "FACULTY",
            toTier: "SENIOR",
            fromStatus: "PENDING",
            toStatus: "PENDING",
            comment: "External participants require senior approval.",
            requestVersion: 1,
          },
          {
            id: U(123),
            requestId: U(113),
            actorId: U(11),
            action: "APPROVE",
            fromTier: "SENIOR",
            toTier: "SENIOR",
            fromStatus: "PENDING",
            toStatus: "APPROVED",
            requestVersion: 1,
          },
          {
            id: U(124),
            requestId: U(114),
            actorId: U(15),
            action: "SUBMIT",
            toTier: "FACULTY",
            toStatus: "PENDING",
            requestVersion: 1,
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.approvalRequestResources)
        .values([
          {
            requestId: U(119),
            resourceUnitId: U(71),
            startsAt: future(-6, 10),
            endsAt: future(-6, 13),
          },
          {
            requestId: U(119),
            resourceUnitId: U(72),
            startsAt: future(-6, 10),
            endsAt: future(-6, 13),
          },
          {
            requestId: U(111),
            resourceUnitId: U(71),
            startsAt: future(7, 9),
            endsAt: future(7, 11),
          },
          {
            requestId: U(115),
            resourceUnitId: U(71),
            startsAt: future(14, 10),
            endsAt: future(14, 13),
          },
          {
            requestId: U(116),
            resourceUnitId: U(72),
            startsAt: future(14, 10),
            endsAt: future(14, 13),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.resourceReservations)
        .values([
          {
            id: U(134),
            requestId: U(119),
            resourceUnitId: U(71),
            eventId: U(83),
            startsAt: future(-6, 10),
            endsAt: future(-6, 13),
            status: "RELEASED",
            confirmedAt: future(-12, 11),
            releasedAt: future(-6, 13),
            releaseReason: "EVENT_COMPLETED",
          },
          {
            id: U(135),
            requestId: U(119),
            resourceUnitId: U(72),
            eventId: U(83),
            startsAt: future(-6, 10),
            endsAt: future(-6, 13),
            status: "RELEASED",
            confirmedAt: future(-12, 11),
            releasedAt: future(-6, 13),
            releaseReason: "EVENT_COMPLETED",
          },
          {
            id: U(130),
            requestId: U(111),
            resourceUnitId: U(71),
            eventId: U(80),
            startsAt: future(7, 9),
            endsAt: future(7, 11),
            status: "CONFIRMED",
            confirmedAt: now,
          },
          {
            id: U(131),
            requestId: U(115),
            resourceUnitId: U(71),
            eventId: U(82),
            startsAt: future(14, 10),
            endsAt: future(14, 13),
            status: "HELD",
            holdExpiresAt: future(3, 23),
          },
          {
            id: U(132),
            requestId: U(116),
            resourceUnitId: U(72),
            eventId: U(82),
            startsAt: future(14, 10),
            endsAt: future(14, 13),
            status: "HELD",
            holdExpiresAt: future(3, 23),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.registrations)
        .values([
          {
            id: U(142),
            eventId: U(83),
            userId: U(16),
            status: "CONFIRMED",
            admissionModeSnapshot: "FCFS",
            eligibilitySnapshot: { version: 1 },
            eventRevision: 1,
            appliedAt: future(-10, 11),
            confirmedAt: future(-10, 11),
          },
          {
            id: U(143),
            eventId: U(83),
            userId: U(18),
            status: "CONFIRMED",
            admissionModeSnapshot: "FCFS",
            eligibilitySnapshot: { version: 1 },
            eventRevision: 1,
            appliedAt: future(-9, 15),
            confirmedAt: future(-9, 15),
          },
          {
            id: U(140),
            eventId: U(80),
            userId: U(16),
            status: "CONFIRMED",
            admissionModeSnapshot: "FCFS",
            eligibilitySnapshot: { version: 1 },
            eventRevision: 1,
            confirmedAt: now,
          },
          {
            id: U(141),
            eventId: U(81),
            userId: U(18),
            status: "APPLIED",
            admissionModeSnapshot: "MANUAL",
            eligibilitySnapshot: { version: 1 },
            eventRevision: 1,
          },
        ])
        .onConflictDoNothing();

      // ── Demo one-day event: one QR of each kind a coordinator can define ───
      // A toggle gate, a one-time attendance QR valid for today only, a
      // switch-only lunch QR, a counted book issue and an unlimited session.
      // Live today so the portal and the app have something real to show.
      await tx
        .insert(s.events)
        .values([
          {
            id: U(180),
            clubId: U(40),
            createdBy: U(14),
            title: "Demo One-Day Tech Fest",
            slug: "demo-one-day-tech-fest",
            description:
              "Demo single-day event showing each kind of access QR a coordinator can define: a toggle gate, one-time attendance, a switch-only lunch, a counted book issue and an unlimited session.",
            template: "CUSTOM",
            status: "LIVE",
            audience: "COLLEGE_ONLY",
            admissionMode: "FCFS",
            capacity: 200,
            startsAt: future(0, 8),
            endsAt: future(0, 22),
            registrationOpensAt: future(-7, 0),
            // Registration must close no later than the event starts.
            registrationClosesAt: future(0, 8),
            venueSummary: "Main Ground and Seminar Hall",
            publishedAt: future(-3, 12),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.checkpoints)
        .values([
          {
            id: U(181),
            eventId: U(180),
            name: "Main gate",
            qrType: "TOGGLE",
            maxUses: null,
            validityMode: "WINDOW",
            startsAt: future(0, 8),
            endsAt: future(0, 22),
            requiresIdCheck: true,
            createdBy: U(14),
          },
          {
            id: U(182),
            eventId: U(180),
            name: "Attendance",
            qrType: "ONE_TIME",
            maxUses: null,
            validityMode: "DATE",
            validOn: future(0, 8).toISOString().slice(0, 10),
            requiresIdCheck: true,
            createdBy: U(14),
          },
          {
            id: U(183),
            eventId: U(180),
            name: "Lunch",
            qrType: "ONE_TIME",
            maxUses: null,
            // No schedule: accepted only while a coordinator keeps it on.
            validityMode: "MANUAL",
            requiresIdCheck: true,
            isActive: false,
            createdBy: U(14),
          },
          {
            id: U(184),
            eventId: U(180),
            name: "Book issue",
            qrType: "COUNTED",
            maxUses: 3,
            validityMode: "WINDOW",
            startsAt: future(0, 9),
            endsAt: future(0, 18),
            requiresIdCheck: true,
            createdBy: U(14),
          },
          {
            id: U(185),
            eventId: U(180),
            name: "DJ night",
            qrType: "UNLIMITED",
            maxUses: null,
            validityMode: "WINDOW",
            startsAt: future(0, 18),
            endsAt: future(0, 22),
            requiresIdCheck: false,
            createdBy: U(14),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.complaintLocations)
        .values([
          {
            id: U(186),
            eventId: U(180),
            label: "Main stage sound desk",
            description: "Stage left, beside the mixing console.",
            createdBy: U(14),
          },
          {
            id: U(187),
            eventId: U(180),
            label: "Food counter",
            description: "Behind the seminar hall, near the water point.",
            createdBy: U(14),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.registrations)
        .values([
          {
            id: U(188),
            eventId: U(180),
            userId: U(16),
            status: "CONFIRMED",
            admissionModeSnapshot: "FCFS",
            eligibilitySnapshot: { version: 1 },
            eventRevision: 1,
            confirmedAt: future(-2, 10),
          },
          {
            id: U(189),
            eventId: U(180),
            userId: U(18),
            status: "CONFIRMED",
            admissionModeSnapshot: "FCFS",
            eligibilitySnapshot: { version: 1 },
            eventRevision: 1,
            confirmedAt: future(-2, 11),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.passes)
        .values([
          { id: U(190), registrationId: U(188) },
          { id: U(191), registrationId: U(189) },
        ])
        .onConflictDoNothing();

      // One entry already recorded, by the club lead — an organiser, not a
      // separate scanning account.
      await tx
        .insert(s.redemptions)
        .values([
          {
            id: U(192),
            passId: U(190),
            checkpointId: U(181),
            scannerId: U(14),
            useNumber: 1,
            direction: "IN",
            redeemedAt: future(0, 9),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.complaints)
        .values([
          {
            id: U(193),
            eventId: U(180),
            locationId: U(186),
            reportedBy: U(16),
            category: "EQUIPMENT",
            description: "Demo report: the left speaker cuts out during announcements.",
            status: "OPEN",
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.complaintUpdates)
        .values([
          {
            id: U(194),
            complaintId: U(193),
            actorId: U(16),
            fromStatus: null,
            toStatus: "OPEN",
            note: "Reported from the location QR.",
          },
        ])
        .onConflictDoNothing();

      // Gate check-in for the completed event, so the report can show verified
      // attendance rather than registration counts alone.
      await tx
        .insert(s.checkpoints)
        .values([
          {
            id: U(170),
            eventId: U(83),
            name: "Lab 2 entry",
            qrType: "UNLIMITED",
            maxUses: null,
            validityMode: "WINDOW",
            startsAt: future(-6, 9),
            endsAt: future(-6, 13),
            requiresIdCheck: true,
            createdBy: U(14),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.passes)
        .values([
          { id: U(171), registrationId: U(142), createdAt: future(-10, 11) },
          { id: U(172), registrationId: U(143), createdAt: future(-9, 15) },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.redemptions)
        .values([
          {
            id: U(173),
            passId: U(171),
            checkpointId: U(170),
            scannerId: U(14),
            redeemedAt: future(-6, 10),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.registrationHistory)
        .values([
          {
            id: U(150),
            registrationId: U(140),
            toStatus: "CONFIRMED",
            actorId: U(16),
            reason: "Demo FCFS confirmation",
          },
          {
            id: U(151),
            registrationId: U(141),
            toStatus: "APPLIED",
            actorId: U(18),
            reason: "Demo manual application",
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.auditLogs)
        .values([
          {
            id: U(160),
            actorId: U(10),
            action: "SEED_DEMO_DATA",
            entityType: "system",
            afterData: { seed: "phase1-demo", roles: ["ADMIN", "FACULTY", "HOD_DEAN", "SUPPORT"] },
          },
        ])
        .onConflictDoNothing();

      // ── Phase 7 demo: both quiz seat-allocation modes, announcements ──────
      await tx
        .insert(s.events)
        .values([
          {
            id: U(84),
            clubId: U(40),
            createdBy: U(14),
            title: "Placement Drive · Backend Engineer",
            slug: "demo-placement-backend",
            description:
              "Demo placement drive. Seats are decided by quiz rank: the highest scores are confirmed once the quiz closes.",
            template: "PLACEMENT_DRIVE",
            status: "PUBLISHED",
            audience: "COLLEGE_ONLY",
            admissionMode: "QUIZ_TOP_N",
            capacity: 3,
            startsAt: future(9, 10),
            endsAt: future(9, 16),
            registrationOpensAt: future(-2, 0),
            registrationClosesAt: future(8, 18),
            venueSummary: "Seminar Hall 1",
            jobDescription:
              "Backend Engineer (Demo). Build and operate APIs. Eligibility: pre-final and final year. Bring your college ID.",
            publishedAt: now,
            submittedAt: future(-3, 9),
          },
          {
            id: U(85),
            clubId: U(40),
            createdBy: U(14),
            title: "Aptitude Sprint · First to Qualify",
            slug: "demo-aptitude-sprint",
            description:
              "Demo limited-seat event. Reach the pass mark to claim a seat; once the seats are gone, qualifiers join the waitlist.",
            template: "HACKATHON",
            status: "PUBLISHED",
            audience: "COLLEGE_ONLY",
            admissionMode: "QUIZ_FIRST_QUALIFIED",
            capacity: 2,
            startsAt: future(5, 15),
            endsAt: future(5, 17),
            registrationOpensAt: future(-2, 0),
            registrationClosesAt: future(5, 12),
            venueSummary: "Computer Lab 2",
            publishedAt: now,
            submittedAt: future(-3, 9),
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(s.quizzes)
        .values([
          {
            id: U(200),
            eventId: U(84),
            mode: "TOP_N",
            status: "PUBLISHED",
            opensAt: future(-1, 0),
            closesAt: future(8, 18),
            durationSeconds: 600,
            passScore: null,
            shuffleQuestions: true,
            instructions:
              "Demo quiz. No negative marking. One attempt. Ties go to whoever submitted first.",
            seats: 3,
            createdBy: U(14),
          },
          {
            id: U(201),
            eventId: U(85),
            mode: "FIRST_QUALIFIED",
            status: "PUBLISHED",
            opensAt: future(-1, 0),
            closesAt: future(5, 12),
            durationSeconds: 300,
            passScore: "60",
            shuffleQuestions: true,
            instructions: "Demo quiz. Score 60% or more to claim a seat while seats last.",
            seats: 2,
            createdBy: U(14),
          },
        ])
        .onConflictDoNothing();

      const demoQuestions = [
        {
          prompt: "Which HTTP status means a resource was created?",
          options: ["200", "201", "204"],
          correctOptionIndex: 1,
        },
        {
          prompt: "What does an index on a database column mainly speed up?",
          options: ["Writes", "Lookups", "Backups"],
          correctOptionIndex: 1,
        },
        {
          prompt: "Which of these is idempotent by HTTP semantics?",
          options: ["POST", "PATCH", "PUT"],
          correctOptionIndex: 2,
        },
        {
          prompt: "A QR nonce is used to prevent which problem?",
          options: ["Slow rendering", "Replay of a captured code", "Large payloads"],
          correctOptionIndex: 1,
        },
        {
          prompt: "Which guarantees a seat cannot be double-booked?",
          options: [
            "Client-side validation",
            "A row lock around the seat count",
            "A longer timeout",
          ],
          correctOptionIndex: 1,
        },
      ];
      await tx
        .insert(s.quizQuestions)
        .values(
          [U(200), U(201)].flatMap((quizId, q) =>
            demoQuestions.map((question, i) => ({
              id: U(210 + q * 10 + i),
              quizId,
              position: i + 1,
              prompt: question.prompt,
              options: question.options,
              correctOptionIndex: question.correctOptionIndex,
              points: "1",
            })),
          ),
        )
        .onConflictDoNothing();

      await tx
        .insert(s.announcements)
        .values([
          {
            id: U(230),
            eventId: U(80),
            title: "Bring your laptop with Git installed",
            body: "Demo announcement: please install Git before the workshop. Lab machines are limited.",
            audience: "REGISTERED",
            isPinned: true,
            createdBy: U(14),
            publishedAt: future(-1, 12),
          },
          {
            id: U(231),
            eventId: U(84),
            title: "Quiz window is open",
            body: "Demo announcement: take the screening quiz before it closes. Your rank decides the seat.",
            audience: "ALL_VISIBLE",
            isPinned: false,
            createdBy: U(14),
            publishedAt: future(-1, 13),
          },
        ])
        .onConflictDoNothing();

      // Real attempts on the placement drive so the ranking and roster have
      // something to review: three scores, none allocated yet (the coordinator
      // still has to close the quiz and allocate).
      await tx
        .insert(s.registrations)
        .values(
          [U(21), U(22), U(23)].map((userId, i) => ({
            id: U(240 + i),
            eventId: U(84),
            userId,
            status: "APPLIED" as const,
            admissionModeSnapshot: "QUIZ_TOP_N" as const,
            eligibilitySnapshot: { version: 1 },
            eventRevision: 1,
            appliedAt: future(-1, 10 + i),
          })),
        )
        .onConflictDoNothing();

      await tx
        .insert(s.quizAttempts)
        .values(
          (
            [
              [U(21), 5, 100, 1],
              [U(22), 4, 80, 2],
              [U(23), 3, 60, 3],
            ] as Array<[string, number, number, number]>
          ).map(([userId, correct, percent, rank], i) => ({
            id: U(250 + i),
            quizId: U(200),
            userId,
            status: "SUBMITTED" as const,
            answers: {},
            score: String(correct),
            percentScore: String(percent),
            qualified: null,
            rank,
            allocatedStatus: null,
            startedAt: future(-1, 11),
            expiresAt: future(-1, 12),
            submittedAt: future(-1, 11 + i / 10),
          })),
        )
        .onConflictDoNothing();

      await tx.execute(sql`SELECT 1`);
    });
    if (env.SEED_DEMO_PASSWORD) {
      if (env.NODE_ENV === "production") {
        throw new Error("SEED_DEMO_PASSWORD must never be used in production.");
      }
      const demoHash = await hashPassword(env.SEED_DEMO_PASSWORD);
      await db
        .update(s.users)
        .set({ passwordHash: demoHash, passwordUpdatedAt: new Date() })
        .where(sql`${s.users.email} LIKE '%@demo.campusops.local'`);
      console.log("demo account passwords enabled for local review");
    }
    console.log("seed complete (idempotent)");
  } finally {
    await closeDb({ db, sql: client });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
