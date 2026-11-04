import { readFileSync, writeFileSync } from "node:fs";
import { assert, call } from "./lib.mjs";

const s = JSON.parse(
  readFileSync(
    process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
    "utf8",
  ),
);
const adminToken = s.adminToken;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const HOUR = 3600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

// Anchor the case to one campus day so the dashboard trend and report read naturally.
const [robotics, debating, sports] = s.clubs;
const clubFaculty = Object.fromEntries(
  s.clubs.map((c) => [c.id, s.faculty.find((f) => c.members.some((m) => m.userId === f.userId))]),
);

const resource = await call("POST", "/resources", {
  token: adminToken,
  body: {
    name: "Main Auditorium",
    description: "600-seat auditorium with stage, projector and green rooms.",
    departmentId: s.departments.CSE.id,
    capacity: 600,
    unitLabels: ["Main Auditorium"],
    metadata: { building: "A Block", floor: 1 },
  },
  label: "auditorium",
});
const unit = await call("GET", `/resources/${resource.id}`, { token: adminToken });
assert(unit.units.length === 1, "auditorium has one bookable unit");

const specs = [
  {
    key: "E1",
    club: robotics,
    lead: s.students[0],
    title: "Autonomous Drone Lab",
    template: "WORKSHOP",
    admissionMode: "FCFS",
    audience: "COLLEGE_ONLY",
    capacity: 60,
    venueSummary: "Robotics Lab, Block C",
    startsAt: iso(2 * MINUTE),
    endsAt: iso(4 * MINUTE),
    registrationOpensAt: iso(-3 * DAY),
    registrationClosesAt: iso(90_000),
    description:
      "A hands-on lab on stabilisation, telemetry and safe flight. Bring a laptop; kits are provided.",
    requests: [
      { type: "ORGANIZE", title: "Permission to run the drone lab", isRequired: true },
      {
        type: "RESOURCE_USE",
        title: "Robotics lab bay and power drops",
        isRequired: true,
        resource: true,
      },
      { type: "CUSTOM", title: "Optional: livestream to the overflow room", isRequired: false },
    ],
  },
  {
    key: "E2",
    club: debating,
    lead: s.students[2],
    title: "Founders' Table: Building in Public",
    template: "SEMINAR",
    admissionMode: "MANUAL",
    audience: "COLLEGE_ONLY",
    capacity: 40,
    venueSummary: "Seminar Hall 2",
    startsAt: iso(2 * DAY),
    endsAt: iso(2 * DAY + 3 * HOUR),
    registrationOpensAt: iso(-2 * DAY),
    registrationClosesAt: iso(2 * DAY - 2 * HOUR),
    description: "Three founders on what they shipped, what broke, and what they would not repeat.",
    requests: [
      { type: "ORGANIZE", title: "Permission to host the founders' table", isRequired: true },
      { type: "CUSTOM", title: "Optional: record the session", isRequired: false },
    ],
  },
  {
    key: "E3",
    club: robotics,
    lead: s.students[1],
    title: "Circuit Sprint Hackathon",
    template: "HACKATHON",
    admissionMode: "QUIZ_TOP_N",
    audience: "COLLEGE_ONLY",
    capacity: 20,
    venueSummary: "Innovation Centre",
    startsAt: iso(3 * DAY),
    endsAt: iso(3 * DAY + 12 * HOUR),
    registrationOpensAt: iso(-DAY),
    registrationClosesAt: iso(3 * DAY - 4 * HOUR),
    description: "Twelve hours, one board, three rounds of hardware debugging. Teams of two.",
    requests: [{ type: "ORGANIZE", title: "Permission to run the hackathon", isRequired: true }],
    quiz: {
      mode: "TOP_N",
      seats: 3,
      passScore: null,
      durationSeconds: 900,
      instructions:
        "Five questions on circuits and debugging. The top three scores take the seats.",
      questions: [
        {
          prompt: "Which component stores charge in a circuit?",
          options: ["Resistor", "Capacitor", "Inductor", "Diode"],
          correctOptionIndex: 1,
          points: 1,
        },
        {
          prompt: "A 5V supply drives a 250Ω resistor. What current flows?",
          options: ["10 mA", "20 mA", "50 mA", "5 mA"],
          correctOptionIndex: 1,
          points: 1,
        },
        {
          prompt: "Which protocol uses two wires, clock and data?",
          options: ["UART", "I2C", "SPI", "CAN"],
          correctOptionIndex: 1,
          points: 1,
        },
        {
          prompt: "What does a pull-up resistor do?",
          options: [
            "Limits current",
            "Holds a line high by default",
            "Filters noise",
            "Steps down voltage",
          ],
          correctOptionIndex: 1,
          points: 1,
        },
        {
          prompt: "Which unit measures capacitance?",
          options: ["Ohm", "Henry", "Farad", "Watt"],
          correctOptionIndex: 2,
          points: 1,
        },
      ],
    },
  },
  {
    key: "E4",
    club: sports,
    lead: s.students[3],
    title: "Inter-College Sports Meet",
    template: "SPORTS",
    admissionMode: "QUIZ_FIRST_QUALIFIED",
    audience: "OUTSIDERS_ALLOWED",
    capacity: 50,
    venueSummary: "Main Ground",
    startsAt: iso(4 * DAY),
    endsAt: iso(4 * DAY + 8 * HOUR),
    registrationOpensAt: iso(-2 * DAY),
    registrationClosesAt: iso(4 * DAY - 6 * HOUR),
    description: "Track and field across eight colleges. Outside athletes welcome with a valid ID.",
    requests: [
      { type: "ORGANIZE", title: "Permission to host the inter-college meet", isRequired: true },
      {
        type: "INVITE_OUTSIDERS",
        title: "Permission to invite outside colleges",
        isRequired: true,
      },
    ],
    quiz: {
      mode: "FIRST_QUALIFIED",
      seats: null,
      passScore: 60,
      durationSeconds: 900,
      instructions:
        "Score 60% or more on the sports knowledge check to qualify. First qualified, first confirmed.",
      questions: [
        {
          prompt: "How many players start on a football pitch per team?",
          options: ["9", "10", "11", "12"],
          correctOptionIndex: 2,
          points: 1,
        },
        {
          prompt: "A marathon is approximately how long?",
          options: ["21.1 km", "42.2 km", "50 km", "10 km"],
          correctOptionIndex: 1,
          points: 1,
        },
        {
          prompt: "In athletics, what is a false start?",
          options: [
            "Starting before the gun",
            "Crossing lanes",
            "Dropping the baton",
            "Finishing early",
          ],
          correctOptionIndex: 0,
          points: 1,
        },
        {
          prompt: "How many sets are needed to win a standard tennis match?",
          options: ["1", "2", "3", "5"],
          correctOptionIndex: 2,
          points: 1,
        },
        {
          prompt: "What is the diameter of a basketball hoop?",
          options: ["40 cm", "45 cm", "50 cm", "60 cm"],
          correctOptionIndex: 1,
          points: 1,
        },
      ],
    },
  },
  {
    key: "E5",
    club: debating,
    lead: s.students[2],
    title: "Alumni Webinar: Life After Campus",
    template: "WEBINAR",
    admissionMode: "FCFS",
    audience: "OUTSIDERS_ALLOWED",
    capacity: 100,
    venueSummary: "Online",
    startsAt: iso(8 * DAY),
    endsAt: iso(8 * DAY + 2 * HOUR),
    registrationOpensAt: iso(-DAY),
    registrationClosesAt: iso(8 * DAY - 3 * HOUR),
    description:
      "Five alumni across research, product and public policy answer unscripted questions.",
    requests: [
      { type: "ORGANIZE", title: "Permission to run the alumni webinar", isRequired: true },
      {
        type: "INVITE_OUTSIDERS",
        title: "Permission to admit outside registrations",
        isRequired: true,
      },
    ],
  },
];

const events = [];
for (const spec of specs) {
  const event = await call("POST", "/events", {
    token: spec.lead.token,
    body: {
      clubId: spec.club.id,
      title: spec.title,
      description: spec.description,
      template: spec.template,
      audience: spec.audience,
      admissionMode: spec.quiz ? "FCFS" : spec.admissionMode,
      capacity: spec.capacity,
      startsAt: spec.startsAt,
      endsAt: spec.endsAt,
      registrationOpensAt: spec.registrationOpensAt,
      registrationClosesAt: spec.registrationClosesAt,
      venueSummary: spec.venueSummary,
      ...(spec.venueSummary === "Online"
        ? { onlineMeetingUrl: "https://meet.example.edu/alumni-webinar" }
        : {}),
    },
    label: spec.title,
  });
  assert(event.status === "DRAFT", `${spec.key} starts as a draft`);
  let current = event;
  if (spec.quiz) {
    const quiz = await call("PUT", `/events/${event.id}/quiz`, {
      token: spec.lead.token,
      body: {
        mode: spec.quiz.mode,
        opensAt: iso(-HOUR),
        closesAt: iso(DAY),
        durationSeconds: spec.quiz.durationSeconds,
        passScore: spec.quiz.passScore,
        shuffleQuestions: false,
        instructions: spec.quiz.instructions,
        seats: spec.quiz.seats,
        questions: spec.quiz.questions,
      },
      label: `quiz ${spec.key}`,
    });
    current = await call("PATCH", `/events/${event.id}`, {
      token: spec.lead.token,
      body: { admissionMode: spec.admissionMode, expectedRevision: event.currentRevision },
      label: `admission ${spec.admissionMode}`,
    });
    assert(
      current.admissionMode === spec.admissionMode,
      `${spec.key} now uses ${spec.admissionMode}`,
    );
    current.quizId = quiz.id;
  }
  events.push({ ...current, spec });
}

// Submit every event with individually decided permissions.
for (const item of events) {
  const approver = clubFaculty[item.clubId] ?? s.faculty[0];
  const requests = item.spec.requests.map((r) => ({
    type: r.type,
    title: r.title,
    isRequired: r.isRequired,
    assignedApproverId:
      r.type === "INVITE_OUTSIDERS"
        ? s.faculty.find((f) => f.departmentCode === "ECE").userId
        : approver.userId,
    ...(r.resource
      ? {
          resources: [
            {
              resourceUnitId: unit.units[0].id,
              startsAt: item.spec.startsAt,
              endsAt: item.spec.endsAt,
            },
          ],
        }
      : {}),
  }));
  await call("POST", `/events/${item.id}/submit`, {
    token: item.spec.lead.token,
    body: {
      expectedRevision: item.currentRevision,
      note: "Submitted for the November cycle.",
      requests,
    },
    label: `submit ${item.spec.key}`,
  });
  const bundle = await call("GET", `/events/${item.id}/approval-bundle`, {
    token: item.spec.lead.token,
    label: `bundle ${item.spec.key}`,
  });
  assert(bundle.event.status === "PENDING_APPROVALS", `${item.spec.key} is awaiting approval`);
  assert(
    bundle.requests.length === item.spec.requests.length,
    `${item.spec.key} has one request per permission`,
  );
  assert(
    bundle.summary.required === item.spec.requests.filter((r) => r.isRequired).length,
    `${item.spec.key} bundle summary counts required requests`,
  );
  item.bundle = bundle;
  item.approver = approver;
}

// Publish a copy of the state before approvals so each step is reproducible.
writeFileSync(
  process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
  JSON.stringify({ ...s, resource, unit, events }, null, 2),
);
console.log("STEP 3 COMPLETE: five drafts submitted, each permission as its own request");
