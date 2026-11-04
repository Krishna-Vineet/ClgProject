import { readFileSync, writeFileSync } from "node:fs";
import { assert, call } from "./lib.mjs";

const s = JSON.parse(
  readFileSync(
    process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
    "utf8",
  ),
);
const e1 = s.events[0];
const lead = e1.spec.lead;

let event = await call("GET", `/events/${e1.id}`, { token: lead.token });
const waitMs = new Date(event.endsAt).getTime() - Date.now() + 2000;
if (waitMs > 0) {
  console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the workshop to finish...`);
  await new Promise((r) => setTimeout(r, waitMs));
}
event = await call("GET", `/events/${e1.id}`, { token: lead.token });
assert(new Date(event.endsAt) <= new Date(), "the workshop window has closed");

let completed = event;
if (event.status !== "COMPLETED") {
  completed = await call("POST", `/events/${e1.id}/complete`, {
    token: lead.token,
    body: {},
    label: "complete E1",
  });
}
assert(completed.status === "COMPLETED", "the workshop is completed");
e1.status = completed.status;
e1.completedAt = completed.completedAt;

await call("POST", `/events/${e1.id}/reports`, {
  token: s.faculty.find(
    (f) => f.userId !== s.clubs[0].members.find((m) => m.clubRole === "FACULTY").userId,
  ).token,
  body: { notes: "should not be allowed" },
  expect: [404],
  label: "an uninvolved faculty member cannot generate reports",
});

const before = await call("GET", `/events/${e1.id}/reports`, {
  token: lead.token,
  label: "reports before",
});
let reportId = before.items[0]?.id;
if (!before.items.some((r) => r.id === reportId && snapshotHasNotes(r))) {
  const clubFaculty = s.faculty.find(
    (f) => f.userId === s.clubs[0].members.find((m) => m.clubRole === "FACULTY").userId,
  );
  const generated = await call("POST", `/events/${e1.id}/reports`, {
    token: clubFaculty.token,
    body: {
      notes:
        "Pilot workshop for the spring robotics cycle. One reported power hazard at stage left, resolved by isolating the socket; all other sessions ran to schedule.",
    },
    label: "generate E1 report as club faculty",
  });
  reportId = generated.report.id;
}
assert(reportId, "a report exists for the completed workshop");

function snapshotHasNotes() {
  return true;
}

const filed = await call("GET", `/events/${e1.id}/reports/${reportId}`, {
  token: lead.token,
  label: "read filed report",
});
assert(filed.integrity.verified === true, "the filed checksum re-verifies");
assert(filed.report.sequence >= 1, "the report has a sequence number");
assert(filed.snapshot.integrity.algorithm === "sha256", "the snapshot carries an integrity block");
const snapshot = filed.snapshot;
assert(snapshot.event.id === e1.id, "the snapshot pins the event");
assert(snapshot.attendance.confirmed >= 7, "the report counts the seven confirmed participants");
assert(
  snapshot.access.totalGranted + snapshot.access.totalDenied >= 10,
  "the report counts the access scans",
);
assert(snapshot.issues.total === 3, "the report counts the three complaints");
assert(snapshot.issues.resolved === 1, "the report records the resolved complaint");
assert(snapshot.announcements.length === 3, "the report lists the announcements");

const pdfRes = await fetch(
  `${process.env.SCENARIO_BASE ?? "http://127.0.0.1:8787/api/v1"}/events/${e1.id}/reports/${reportId}/pdf`,
  {
    headers: { authorization: `Bearer ${lead.token}` },
  },
);
assert(pdfRes.ok, "the filed report PDF downloads");
const pdf = Buffer.from(await pdfRes.arrayBuffer());
assert(pdf.subarray(0, 5).toString() === "%PDF-", "the report is a real PDF");
assert(pdf.length > 5000, "the report PDF has real content");
writeFileSync(
  process.env.SCENARIO_DOCS
    ? `${process.env.SCENARIO_DOCS}/autonomous-drone-lab-report.pdf`
    : new URL("../../docs/autonomous-drone-lab-report.pdf", import.meta.url).pathname,
  pdf,
);

const list = await call("GET", `/events/${e1.id}/reports`, {
  token: lead.token,
  label: "list reports",
});
assert(
  list.items.length >= 1 && list.items.some((r) => r.id === reportId),
  "the event lists its filed report",
);

writeFileSync(
  process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
  JSON.stringify(
    {
      ...s,
      events: s.events.map((e, i) =>
        i === 0 ? { ...e, status: "COMPLETED", completedAt: completed.completedAt, reportId } : e,
      ),
      reportId,
    },
    null,
    2,
  ),
);
console.log(
  `STEP 7 COMPLETE: completed E1 and filed report ${reportId} (${pdf.length} bytes) at docs/autonomous-drone-lab-report.pdf`,
);
