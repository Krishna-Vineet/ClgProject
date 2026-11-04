import { readFileSync, writeFileSync } from "node:fs";
import { assert, call, login } from "./lib.mjs";
const s = JSON.parse(
  readFileSync(
    process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
    "utf8",
  ),
);
const adminToken = s.adminToken;

// 1. Faculty verification queue, as faculty #1.
const queue = await call("GET", "/faculty/verification-queue?limit=100", {
  token: s.faculty[0].token,
});
console.log(
  "queue size:",
  queue.items.length,
  queue.items.map((r) => `${r.fullName}:${r.status}`).join(", "),
);
assert(
  queue.items.length === 3,
  "a CSE faculty member sees only the three CSE students awaiting verification",
);

// A HOD/Dean should be able to verify a student in their own department. Try it.
const target = queue.items[0];
let hodVerified = false;
try {
  await call("POST", `/faculty/students/${target.id}/verify`, {
    token: s.hods.find((h) => h.departmentCode === "CSE").token,
    body: { note: "ID card checked at the department office." },
    expect: [200, 201],
    label: "HOD verifies own-department student",
  });
  hodVerified = true;
} catch {
  console.log("  ! HOD could not verify a student in their own department");
}

// Verify every student as faculty in the student's own department.
for (const student of s.students) {
  const dept = s.departments[student.departmentCode];
  const fac = s.faculty.find((f) => f.departmentId === dept.id);
  const queueForDept = await call("GET", "/faculty/verification-queue?limit=100", {
    token: fac.token,
  });
  const row = queueForDept.items.find((r) => r.id === student.userId);
  if (!row) {
    assert(
      hodVerified && student === s.students[0],
      `${student.fullName} was already verified by the HOD`,
    );
    continue;
  }
  await call("POST", `/faculty/students/${row.id}/verify`, {
    token: fac.token,
    body: { note: "College ID and roll number matched the department register." },
    label: row.fullName,
  });
}
for (const deptCode of ["CSE", "ECE", "MECH"]) {
  const dept = s.departments[deptCode];
  const fac = s.faculty.find((f) => f.departmentId === dept.id);
  const after = await call("GET", "/faculty/verification-queue?limit=100", { token: fac.token });
  assert(after.items.length === 0, `${deptCode} verification queue is empty`);
}

// Check the students can now use the app.
for (const student of s.students) {
  const me = await call("GET", "/me", { token: student.token, label: student.fullName });
  student.status = me.user.status;
  assert(me.user.status === "ACTIVE", `${student.fullName} is ACTIVE after verification`);
  assert(me.user.phone === student.phone, `${student.fullName}'s phone is stored`);
}

// 2. Three clubs, five leads, two coordinators and three club-faculty members.
const clubSpecs = [
  {
    name: "Robotics Society",
    slug: "robotics-society",
    departmentCode: "CSE",
    description: "Builds, breaks and rebuilds campus hardware.",
    leads: [0, 1],
    coordinators: [5],
    faculty: [0],
  },
  {
    name: "Debating Union",
    slug: "debating-union",
    departmentCode: "ECE",
    description: "Weekly motions, open to every department.",
    leads: [2],
    coordinators: [6],
    faculty: [1],
  },
  {
    name: "Sports Council",
    slug: "sports-council",
    departmentCode: "MECH",
    description: "Inter-college fixtures and campus leagues.",
    leads: [3, 4],
    coordinators: [],
    faculty: [2],
  },
];
const clubs = [];
for (const spec of clubSpecs) {
  const club = await call("POST", "/clubs", {
    token: adminToken,
    body: {
      name: spec.name,
      slug: spec.slug,
      description: spec.description,
      departmentId: s.departments[spec.departmentCode].id,
    },
    label: spec.name,
  });
  const members = [];
  for (const idx of spec.leads) {
    members.push(
      await call("POST", `/clubs/${club.id}/members`, {
        token: adminToken,
        body: { userId: s.students[idx].userId, clubRole: "LEAD" },
        label: `lead ${s.students[idx].fullName}`,
      }),
    );
  }
  for (const idx of spec.coordinators) {
    members.push(
      await call("POST", `/clubs/${club.id}/members`, {
        token: adminToken,
        body: { userId: s.students[idx].userId, clubRole: "COORDINATOR" },
        label: `coordinator ${s.students[idx].fullName}`,
      }),
    );
  }
  for (const idx of spec.faculty) {
    members.push(
      await call("POST", `/clubs/${club.id}/members`, {
        token: adminToken,
        body: { userId: s.faculty[idx].userId, clubRole: "FACULTY" },
        label: `club faculty ${s.faculty[idx].fullName}`,
      }),
    );
  }
  clubs.push({ ...club, members, spec });
}
assert(clubs.length === 3, "three clubs created with leads, coordinators and club faculty");
const leadCount = clubs.reduce(
  (n, c) => n + c.members.filter((m) => m.clubRole === "LEAD").length,
  0,
);
const coordCount = clubs.reduce(
  (n, c) => n + c.members.filter((m) => m.clubRole === "COORDINATOR").length,
  0,
);
assert(leadCount === 5, "five students hold LEAD memberships");
assert(coordCount === 2, "two students hold COORDINATOR memberships");

// Leadership must be visible on the phone.
for (const club of clubs) {
  for (const member of club.members) {
    const student = s.students.find((st) => st.userId === member.userId);
    if (!student) continue;
    const me = await call("GET", "/me", { token: student.token });
    assert(
      me.clubMemberships.some((m) => m.clubId === club.id && m.clubRole === member.clubRole),
      `${student.fullName} sees the ${member.clubRole} role on /me`,
    );
  }
}

writeFileSync(
  process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
  JSON.stringify({ ...s, clubs, hodVerified }, null, 2),
);
console.log("STEP 2 COMPLETE");
