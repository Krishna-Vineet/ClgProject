import { readFileSync, writeFileSync } from "node:fs";
import { assert, call } from "./lib.mjs";

const s = JSON.parse(
  readFileSync(
    process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
    "utf8",
  ),
);
const adminToken = s.adminToken;
const facultyById = Object.fromEntries(s.faculty.map((f) => [f.userId, f]));
const clubFaculty = (event) => {
  const club = s.clubs.find((c) => c.id === event.clubId);
  const member = club.members.find((m) => s.faculty.some((f) => f.userId === m.userId));
  return s.faculty.find((f) => f.userId === member.userId);
};
const bundleOf = (event) =>
  call("GET", `/events/${event.id}/approval-bundle`, {
    token: event.spec.lead.token,
    label: `bundle ${event.spec.key}`,
  });

// Publishing before approvals must be refused with the blocking requests listed.
const draftBundle = await bundleOf(s.events[0]);
await call("POST", `/events/${s.events[0].id}/publish`, {
  token: s.events[0].spec.lead.token,
  body: { expectedRevision: draftBundle.event.currentRevision },
  expect: [422],
  label: "publish blocked before approvals",
});

for (const event of s.events) {
  const fac = clubFaculty(event);
  let bundle = await bundleOf(event);
  const byType = (type) => bundle.requests.filter((r) => r.request.type === type);

  // The optional request on E1 is rejected with a reason; it must not block publishing.
  if (event.spec.key === "E1") {
    const optional = byType("CUSTOM")[0];
    await call("POST", `/approval-requests/${optional.request.id}/decision`, {
      token: fac.token,
      body: {
        action: "REJECT",
        comment:
          "Overflow room is already booked for the placement drive; livestream not approved.",
        expectedVersion: optional.request.version,
      },
      label: "faculty rejects optional livestream",
    });
  }

  // A faculty member who is not the assignee cannot decide.
  if (event.spec.key === "E2") {
    const organize = byType("ORGANIZE")[0];
    const outsider = s.faculty.find((f) => f.userId !== fac.userId && f.departmentCode === "ECE");
    await call("POST", `/approval-requests/${organize.request.id}/decision`, {
      token: outsider.token,
      body: { action: "APPROVE", expectedVersion: organize.request.version },
      expect: [403],
      label: "unassigned faculty cannot decide",
    });
    const optional = byType("CUSTOM")[0];
    await call("POST", `/approval-requests/${optional.request.id}/decision`, {
      token: fac.token,
      body: {
        action: "REQUEST_CHANGES",
        comment: "Name the camera operator and where the recording will be stored.",
        expectedVersion: optional.request.version,
      },
      label: "faculty requests changes on optional recording",
    });
  }

  // E4's outsider permission is escalated twice: FACULTY -> HOD/Dean -> Admin.
  if (event.spec.key === "E4") {
    let outsider = byType("INVITE_OUTSIDERS")[0];
    const outsiderAssignee = s.faculty.find((f) => f.userId === outsider.assignee?.id) ?? fac;
    await call("POST", `/approval-requests/${outsider.request.id}/escalate`, {
      token: outsiderAssignee.token,
      body: {
        toTier: "SENIOR",
        comment: "Eight colleges involved; the department head should see the guest list.",
        expectedVersion: outsider.request.version,
      },
      label: "faculty escalates to HOD",
    });
    bundle = await bundleOf(event);
    outsider = bundle.requests.find((r) => r.request.id === outsider.request.id);
    const hod = s.hods.find((h) => h.departmentCode === "MECH");
    await call("POST", `/approval-requests/${outsider.request.id}/escalate`, {
      token: hod.token,
      body: {
        toTier: "ADMIN",
        comment: "Inter-college fixture; the principal signs off on outside participation.",
        expectedVersion: outsider.request.version,
      },
      label: "HOD escalates to Admin",
    });
    bundle = await bundleOf(event);
    outsider = bundle.requests.find((r) => r.request.id === outsider.request.id);
    await call("POST", `/approval-requests/${outsider.request.id}/decision`, {
      token: adminToken,
      body: {
        action: "APPROVE",
        comment: "Approved for this fixture only; share the final guest list with security.",
        expectedVersion: outsider.request.version,
      },
      label: "Admin approves outside participation",
    });
    bundle = await bundleOf(event);
  }

  // Approve the remaining required requests as the assigned faculty member.
  for (const row of bundle.requests) {
    if (!row.request.isRequired) continue;
    if (row.request.status !== "PENDING") continue;
    await call("POST", `/approval-requests/${row.request.id}/decision`, {
      token: fac.token,
      body: {
        action: "APPROVE",
        comment:
          row.request.type === "RESOURCE_USE"
            ? "Bay is free; keep the power drops off the main breaker."
            : "Checked against the department calendar and the safety checklist.",
        expectedVersion: row.request.version,
      },
      label: `${event.spec.key} ${row.request.type}`,
    });
  }

  bundle = await bundleOf(event);
  assert(bundle.summary.readyToPublish === true, `${event.spec.key} is ready to publish`);
  const published = await call("POST", `/events/${event.id}/publish`, {
    token: event.spec.lead.token,
    body: { expectedRevision: bundle.event.currentRevision },
    label: `publish ${event.spec.key}`,
  });
  const pubEvent = published.event ?? published;
  assert(pubEvent.status === "PUBLISHED", `${event.spec.key} is published`);
  event.status = pubEvent.status;
  event.currentRevision = pubEvent.currentRevision;
  event.publishedAt = pubEvent.publishedAt;
}

// Start the workshop early so the access and complaint flows can run today.
const e1 = s.events[0];
const started = await call("POST", `/events/${e1.id}/start`, {
  token: e1.spec.lead.token,
  label: "start E1",
});
assert(started.status === "LIVE", "the drone lab is LIVE and open for scanning");
e1.status = started.status;

// Publish both quizzes so participants can attempt them.
for (const event of s.events.filter((e) => e.quizId)) {
  const quiz = await call("PATCH", `/quizzes/${event.quizId}/status`, {
    token: event.spec.lead.token,
    body: { status: "PUBLISHED" },
    label: `publish quiz ${event.spec.key}`,
  });
  assert(quiz.status === "PUBLISHED", `${event.spec.key} quiz is published`);
  event.quizStatus = quiz.status;
}

writeFileSync(
  process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
  JSON.stringify({ ...s, events: s.events }, null, 2),
);
console.log(
  "STEP 4 COMPLETE: approvals (incl. rejection, escalation to HOD and Admin) and publishing",
);
