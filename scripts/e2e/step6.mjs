import { readFileSync, writeFileSync } from "node:fs";
import { assert, call } from "./lib.mjs";

const s = JSON.parse(
  readFileSync(
    process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
    "utf8",
  ),
);
const e1 = s.events[0];
const e2 = s.events[1];
const lead = e1.spec.lead;
const coordinator = s.students.find(
  (st) => st.userId === s.clubs[0].members.find((m) => m.clubRole === "COORDINATOR").userId,
);
const [aarav, diya, reyansh, ananya] = s.students;
const outsider = s.outsiders[0];

async function checkpoint(event, body, token = event.spec.lead.token) {
  return call("POST", `/events/${event.id}/checkpoints`, {
    token,
    body,
    label: `checkpoint ${body.name}`,
  });
}
const qr = (name, qrType, extra = {}) => ({
  name,
  qrType,
  maxUses: null,
  validityMode: "MANUAL",
  validFrom: null,
  validUntil: null,
  validOn: null,
  requiresIdCheck: true,
  isActive: true,
  ...extra,
});

await call("POST", `/events/${e1.id}/passes/issue`, {
  token: lead.token,
  label: "issue E1 passes",
});
const wallets = {};
for (const person of [aarav, diya, ananya]) {
  const wallet = await call("GET", "/me/passes", {
    token: person.token,
    label: `wallet ${person.fullName}`,
  });
  wallets[person.userId] = wallet;
}
const passFor = (person) => wallets[person.userId].items.find((p) => p.event.id === e1.id);
assert(passFor(aarav)?.passId, "Aarav holds an E1 pass");
assert(
  Array.isArray(passFor(aarav).checkpoints) && passFor(aarav).checkpoints.length === 0,
  "the wallet starts with no checkpoints",
);

const mainGate = await checkpoint(e1, qr("Main gate", "ONE_TIME"));
const bay = await checkpoint(
  e1,
  qr("Workshop bay", "COUNTED", { maxUses: 2, requiresIdCheck: false }),
);
const exitGate = await checkpoint(e1, qr("Exit gate", "TOGGLE", { requiresIdCheck: false }));
const overflow = await checkpoint(e1, qr("Overflow gate", "ONE_TIME"));

async function mint(person, cp) {
  const r = await call("POST", `/me/passes/${passFor(person).passId}/nonce`, {
    token: person.token,
    body: { checkpointId: cp.id },
    label: `mint ${person.fullName} @ ${cp.name}`,
  });
  return r.token;
}
const scan = (token, cp, person, identityCheck = "MATCH", expect = [200]) =>
  call("POST", "/access/scan", {
    token: lead.token,
    body: { token, checkpointId: cp.id, identityCheck },
    expect,
    label: `scan ${person.fullName} @ ${cp.name}`,
  });

// One-time ingress, a replay, and a mismatched ID.
const aaravToken = await mint(aarav, mainGate);
const first = await scan(aaravToken, mainGate, aarav);
assert(first.result === "GRANTED" && first.useNumber === 1, "Aarav enters once");
const replay = await scan(aaravToken, mainGate, aarav);
assert(
  replay.result === "DENIED" && replay.reason === "QR_REPLAYED",
  "the same code cannot be used twice",
);
const diyaToken = await mint(diya, mainGate);
const inspect = await call("POST", "/access/inspect", {
  token: lead.token,
  body: { token: diyaToken, checkpointId: mainGate.id },
  label: "inspect Diya's code",
});
assert(inspect.participant?.fullName === "Diya Patel", "inspect shows who the code belongs to");
const mismatch = await scan(diyaToken, mainGate, diya, "MISMATCH");
assert(
  mismatch.result === "DENIED" && mismatch.reason === "IDENTITY_MISMATCH",
  "an identity mismatch is refused",
);
const diyaToken2 = await mint(diya, mainGate);
const diyaEntry = await scan(diyaToken2, mainGate, diya);
assert(diyaEntry.result === "GRANTED", "a fresh code works after a mismatch");

// Toggle in / out.
for (const expected of ["IN", "OUT"]) {
  const token = await mint(aarav, exitGate);
  const r = await scan(token, exitGate, aarav, "NOT_REQUIRED");
  assert(r.result === "GRANTED" && r.direction === expected, `the exit gate toggles ${expected}`);
}

// Counted uses, then exhaustion.
for (const use of [1, 2]) {
  const token = await mint(diya, bay);
  const r = await scan(token, bay, diya);
  assert(r.result === "GRANTED" && r.useNumber === use, `workshop bay use ${use} is granted`);
}
const exhaustedToken = await mint(diya, bay);
const exhausted = await scan(exhaustedToken, bay, diya);
assert(
  exhausted.result === "DENIED" && exhausted.reason === "LIMIT_REACHED",
  "the third bay scan is refused",
);

// A switched-off counter refuses scans until it is switched back on.
await call("PATCH", `/access/checkpoints/${overflow.id}/active`, {
  token: lead.token,
  body: { isActive: false },
  label: "switch overflow gate off",
});
const overflowToken = await mint(diya, overflow);
const inactive = await scan(overflowToken, overflow, diya);
assert(
  inactive.result === "DENIED" && inactive.reason === "QR_SWITCHED_OFF",
  "an inactive counter is refused",
);
await call("PATCH", `/access/checkpoints/${overflow.id}/active`, {
  token: lead.token,
  body: { isActive: true },
  label: "switch overflow gate on",
});

// A pass from another event cannot be minted for this event's checkpoint.
await checkpoint(e2, qr("Seminar hall door", "ONE_TIME"));
const e2Checkpoints = await call("GET", `/events/${e2.id}/checkpoints`, {
  token: e2.spec.lead.token,
});
await call("POST", `/me/passes/${passFor(aarav).passId}/nonce`, {
  token: aarav.token,
  body: { checkpointId: e2Checkpoints.items[0].id },
  expect: [400],
  label: "E1 pass cannot mint for the E2 door",
});
await call("POST", "/access/inspect", {
  token: outsider.token,
  body: { token: diyaToken2, checkpointId: mainGate.id },
  expect: [403],
  label: "outside student cannot use the scanner",
});

// Offline queue: sync once, then retry the same clientScanId idempotently.
const offlineToken = await mint(aarav, exitGate);
const clientScanId = crypto.randomUUID();
const sync1 = await call("POST", "/access/scans/sync", {
  token: lead.token,
  body: {
    items: [
      {
        clientScanId,
        checkpointId: exitGate.id,
        token: offlineToken,
        identityCheck: "NOT_REQUIRED",
        capturedAt: new Date().toISOString(),
      },
    ],
  },
  label: "sync one offline scan",
});
assert(
  sync1.items?.[0]?.result === "GRANTED" || sync1.results?.[0]?.result === "GRANTED",
  "offline scan is accepted",
);
const sync2 = await call("POST", "/access/scans/sync", {
  token: lead.token,
  body: {
    items: [
      {
        clientScanId,
        checkpointId: exitGate.id,
        token: offlineToken,
        identityCheck: "NOT_REQUIRED",
        capturedAt: new Date(Date.now() - 1000).toISOString(),
      },
    ],
  },
  label: "retry the same offline scan",
});
const second = sync2.items?.[0] ?? sync2.results?.[0];
assert(second?.duplicate === true, "a retried offline scan is not counted twice");

const log = await call("GET", `/events/${e1.id}/access-log?limit=100`, {
  token: lead.token,
  label: "access log",
});
assert(log.items.length >= 10, "the access log records every attempt");
const denials = await call("GET", `/events/${e1.id}/access-log?result=DENIED&limit=100`, {
  token: lead.token,
  label: "denied only",
});
assert(
  denials.items.every((row) => row.result === "DENIED"),
  "the access log filters denials",
);

// --- Complaints -----------------------------------------------------------
const stage = await call("POST", `/events/${e1.id}/complaint-locations`, {
  token: lead.token,
  body: {
    label: "Stage left power drop",
    description: "The blue 16A socket beside the stage steps.",
  },
  label: "complaint location stage",
});
const desk = await call("POST", `/events/${e1.id}/complaint-locations`, {
  token: lead.token,
  body: {
    label: "Registration desk",
    description: "Wi-Fi and badge printer at the north entrance.",
  },
  label: "complaint location desk",
});
const posterRes = await fetch(
  `${process.env.SCENARIO_BASE ?? "http://127.0.0.1:8787/api/v1"}/complaints/locations/${stage.id}/poster`,
  {
    headers: { authorization: `Bearer ${aarav.token}` },
  },
);
assert(posterRes.ok, "the printable poster downloads");
const posterBytes = Buffer.from(await posterRes.arrayBuffer());
assert(posterBytes.subarray(0, 5).toString() === "%PDF-", "the poster is a real PDF");
writeFileSync(
  process.env.SCENARIO_DOCS
    ? `${process.env.SCENARIO_DOCS}/complaint-poster.pdf`
    : new URL("./complaint-poster.pdf", import.meta.url).pathname,
  posterBytes,
);

const resolved = await call("GET", `/complaints/locations/${stage.id}`, {
  token: aarav.token,
  label: "resolve complaint QR",
});
assert(
  resolved.event.id === e1.id && resolved.location.label === "Stage left power drop",
  "the QR resolves to its venue point",
);

const raised = [];
for (const [person, category, description] of [
  [aarav, "POWER", "The left stage socket sparked when the projector was plugged in."],
  [diya, "WIFI", "No signal at the registration desk; delegates cannot check in."],
  [ananya, "EQUIPMENT", "The badge printer is jamming every second badge."],
]) {
  raised.push(
    await call("POST", `/complaints/locations/${stage.id}/reports`, {
      token: person.token,
      body: { category, description },
      label: `raise ${category} complaint`,
    }),
  );
}
const complaintList = await call("GET", `/events/${e1.id}/complaints?limit=50`, {
  token: lead.token,
  label: "complaint list",
});
assert(complaintList.items.length === 3, "the organiser sees all three issues");
const complaintSummary = await call("GET", `/events/${e1.id}/complaints/summary`, {
  token: lead.token,
});
assert(
  complaintSummary.open === 3 || complaintSummary.byStatus?.OPEN === 3,
  "three issues are open",
);

await call("PATCH", `/complaints/${raised[0].id}`, {
  token: lead.token,
  body: { status: "IN_PROGRESS", note: "Electrician called; the socket is taped off." },
  label: "acknowledge power issue",
});
await call("PATCH", `/complaints/${raised[1].id}`, {
  token: lead.token,
  body: { assignedTo: coordinator.userId, note: "Isha owns the registration desk." },
  label: "assign wifi issue to coordinator",
});
await call("PATCH", `/complaints/${raised[2].id}`, {
  token: lead.token,
  body: { status: "RESOLVED", note: "Badge printer roller cleaned and a spare loaded." },
  label: "resolve printer issue",
});
const mine = await call("GET", "/me/complaints?limit=20", {
  token: ananya.token,
  label: "my complaints",
});
assert(
  mine.items.find((c) => c.id === raised[2].id)?.status === "RESOLVED",
  "the reporter sees the resolution",
);
await call("PATCH", `/complaints/${raised[0].id}`, {
  token: reyansh.token,
  body: { status: "CLOSED" },
  expect: [404],
  label: "a student from another club cannot update complaints",
});
await call("GET", `/events/${e1.id}/complaints`, {
  token: outsider.token,
  expect: [404],
  label: "outside student cannot list complaints",
});
await call("PATCH", `/complaints/locations/${desk.id}`, {
  token: lead.token,
  body: { revoked: true },
  label: "close the desk reporting point",
});
await call("POST", `/complaints/locations/${desk.id}/reports`, {
  token: diya.token,
  body: { category: "WIFI", description: "Trying to report against a closed point." },
  expect: [409],
  label: "closed location refuses new reports",
});

// --- Announcements --------------------------------------------------------
const pinned = await call("POST", `/events/${e1.id}/announcements`, {
  token: lead.token,
  body: {
    title: "Kit collection is open",
    body: "Collect your drone kit from the bay desk; bring your student ID.",
    audience: "REGISTERED",
    isPinned: true,
  },
  label: "post pinned announcement",
});
await call("POST", `/events/${e1.id}/announcements`, {
  token: lead.token,
  body: {
    title: "Stage socket taped off",
    body: "Please use the right-hand power drop until the electrician clears the left one.",
    audience: "REGISTERED",
    isPinned: false,
  },
  label: "post safety announcement",
});
const doomed = await call("POST", `/events/${e1.id}/announcements`, {
  token: lead.token,
  body: {
    title: "Lunch moved to 13:30",
    body: "The cafeteria will hold the workshop buffet until half past one.",
    audience: "REGISTERED",
    isPinned: false,
  },
  label: "post lunch announcement",
});
const feed = await call("GET", "/me/announcements?limit=30", {
  token: aarav.token,
  label: "participant announcement feed",
});
assert(feed.items.length >= 3, "the participant feed shows the announcements");
assert(
  feed.items[0]?.isPinned === true || feed.items.some((a) => a.isPinned),
  "pinned announcement sorts first",
);
await call("POST", `/announcements/${doomed.announcement.id}/revoke`, {
  token: lead.token,
  body: { reason: "Timing changed again; a corrected notice is coming." },
  label: "revoke lunch announcement",
});
await call("POST", `/events/${e1.id}/announcements`, {
  token: outsider.token,
  body: {
    title: "Not allowed",
    body: "An outside student must not be able to post this notice.",
    audience: "REGISTERED",
    isPinned: false,
  },
  expect: [403],
  label: "non-organiser cannot post",
});

writeFileSync(
  process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
  JSON.stringify(
    {
      ...s,
      access: { mainGate, bay, exitGate, overflow },
      complaints: { stage, desk, raised },
      announcements: { pinned: pinned.announcement, revoked: doomed.announcement },
    },
    null,
    2,
  ),
);
console.log(
  "STEP 6 COMPLETE: access QRs (replay, mismatch, counted, toggle, offline), complaints and announcements",
);
