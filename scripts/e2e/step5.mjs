import { readFileSync, writeFileSync } from "node:fs";
import { assert, call } from "./lib.mjs";

const s = JSON.parse(
  readFileSync(
    process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
    "utf8",
  ),
);
const [e1, e2, e3, e4, e5] = s.events;
const student = (i) => s.students[i];
const outsider = (i) => s.outsiders[i];

async function register(event, person, expect = [200, 201], label = person.fullName) {
  return call("POST", `/events/${event.id}/register`, {
    token: person.token,
    body: {},
    idempotencyKey: `reg-${event.id}-${person.userId}`,
    expect,
    label: `${event.spec.key} ${label}`,
  });
}
async function registrationOf(event, person) {
  const mine = await call("GET", "/me/registrations?limit=100", {
    token: person.token,
    label: "my registrations",
  });
  return mine.items.find((r) => r.event.id === event.id);
}

// E1 — FCFS, college-only, LIVE.
for (const st of s.students) {
  const r = await register(e1, st);
  assert(r.registration.status === "CONFIRMED", `${st.fullName} is confirmed for the drone lab`);
}
await register(e1, outsider(0), [404], "outside student cannot even see the college-only event");
const passer = await registrationOf(e1, student(0));
assert(
  passer?.event?.title === "Autonomous Drone Lab",
  "the phone lists the event title for an E1 registration",
);

// E2 — manual admission: apply, then decide from the roster.
for (const i of [0, 1, 2, 3, 4]) {
  const r = await register(e2, student(i));
  assert(
    r.registration.status === "APPLIED",
    `${student(i).fullName} applied to the founders' table`,
  );
}
let roster = await call("GET", `/events/${e2.id}/registrations?limit=50`, {
  token: e2.spec.lead.token,
  label: "E2 roster",
});
assert(roster.items.length === 5, "the manual roster shows all five applications");
const decisions = [
  ["CONFIRMED", "Statement of purpose reviewed; seat offered."],
  ["CONFIRMED", "Second-year delegate; confirmed."],
  ["CONFIRMED", "Confirmed from the debate society shortlist."],
  ["REJECTED", "Outside the seminar's current-year eligibility window."],
];
for (const [i, [decision, note]] of decisions.entries()) {
  const row = roster.items[i];
  await call("POST", `/events/${e2.id}/registrations/${row.id}/decision`, {
    token: e2.spec.lead.token,
    body: { decision, note },
    label: `E2 ${decision} ${row.fullName}`,
  });
}
roster = await call("GET", `/events/${e2.id}/registrations?limit=50`, {
  token: e2.spec.lead.token,
  label: "E2 roster after",
});
const confirmed = roster.items.filter((r) => r.status === "CONFIRMED").length;
const applied = roster.items.filter((r) => r.status === "APPLIED").length;
const rejected = roster.items.filter((r) => r.status === "REJECTED").length;
assert(
  confirmed === 3 && applied === 1 && rejected === 1,
  "manual decisions leave 3 confirmed, 1 applied and 1 rejected",
);
const rejectedView = await registrationOf(e2, student(3));
assert(rejectedView.status === "REJECTED", "the rejected student sees the decision on their phone");

// E5 — FCFS with outsiders allowed.
for (const person of [...s.outsiders, student(0), student(1)]) {
  const r = await register(e5, person);
  assert(r.registration.status === "CONFIRMED", `${person.fullName} is confirmed for the webinar`);
}

// Quiz helpers.

async function attemptQuiz(event, person, correctCount) {
  const reg = await register(event, person, [200, 201], person.fullName);
  const started = await call("POST", `/events/${event.id}/quiz/attempts`, {
    token: person.token,
    body: {},
    label: `start quiz ${event.spec.key} ${person.fullName}`,
  });
  const questions = started.questions ?? started.paper?.questions ?? started.paper ?? [];
  assert(
    Array.isArray(questions) && questions.length === 5,
    `${person.fullName} received five questions`,
  );
  const keyByPrompt = Object.fromEntries(
    event.spec.quiz.questions.map((q) => [q.prompt, q.correctOptionIndex]),
  );
  const answers = {};
  questions.forEach((q, idx) => {
    const correct = keyByPrompt[q.prompt] ?? 0;
    answers[q.id] = idx < correctCount ? correct : (correct + 1) % q.options.length;
  });
  const result = await call("POST", `/events/${event.id}/quiz/attempts/submit`, {
    token: person.token,
    body: { answers },
    headers: { "idempotency-key": `quiz-${event.id}-${person.userId}` },
    label: `submit ${correctCount}/5 ${person.fullName}`,
  });
  return { reg, started, result, answers };
}

// E3 — quiz top 3 of 6.
const e3Participants = s.students.slice(0, 6);
const e3Scores = [5, 5, 5, 4, 3, 2];
const e3Results = [];
for (const [i, person] of e3Participants.entries()) {
  e3Results.push(await attemptQuiz(e3, person, e3Scores[i]));
}
await call("PATCH", `/quizzes/${e3.quizId}/status`, {
  token: e3.spec.lead.token,
  body: { status: "CLOSED" },
  label: "close E3 quiz",
});
await call("POST", `/quizzes/${e3.quizId}/allocate`, {
  token: e3.spec.lead.token,
  body: { note: "Top three scores take the twenty seats; ties broken by submission time." },
  label: "allocate E3 seats",
});
const organiserQuiz = await call("GET", `/events/${e3.id}/quiz`, { token: e3.spec.lead.token });
assert(organiserQuiz.quiz.allocatedAt, "E3 seats were allocated once");
const leaderboard = await call("GET", `/quizzes/${e3.quizId}/leaderboard?limit=20`, {
  token: e3.spec.lead.token,
  label: "E3 leaderboard",
});
assert(leaderboard.items.length === 6, "leaderboard ranks all six submissions");
assert(
  leaderboard.items[0].percentScore >= leaderboard.items[5].percentScore,
  "leaderboard is ordered by score",
);
const e3Statuses = [];
for (const person of e3Participants) {
  const row = await registrationOf(e3, person);
  e3Statuses.push(row.status);
}
assert(
  e3Statuses.filter((x) => x === "CONFIRMED").length === 3,
  "exactly three quiz winners are confirmed",
);

// E4 — first qualified: pass score 60%, outsiders allowed.
const e4Participants = [...s.outsiders, ...s.students.slice(0, 5)];
const e4Scores = [5, 4, 3, 3, 2, 5, 4, 3, 2, 1];
for (const [i, person] of e4Participants.entries()) {
  await attemptQuiz(e4, person, e4Scores[i]);
}
const e4Statuses = [];
for (const person of e4Participants) {
  const row = await registrationOf(e4, person);
  e4Statuses.push({
    name: person.fullName,
    status: row.status,
    score: row.quiz?.percentScore ?? null,
  });
}
assert(
  e4Statuses.filter((x) => x.status === "CONFIRMED").length >= 3,
  "every qualifier above the pass score is confirmed",
);

writeFileSync(
  process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
  JSON.stringify(
    {
      ...s,
      registrations: {
        e1: s.students.length,
        e2: { confirmed, applied, rejected },
        e3: e3Statuses,
        e4: e4Statuses,
      },
    },
    null,
    2,
  ),
);
console.log("STEP 5 COMPLETE: FCFS, manual decisions, quiz top-N and first-qualified admissions");
