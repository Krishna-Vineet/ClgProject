import { assert, call, login, registerStudent, setupStaff, state } from "./lib.mjs";

const PASSWORD = "Northfield#2026";
const admin = await login("admin@northfield.edu", "CampusOps#2026");
const adminToken = admin.accessToken;
state.admin = admin;

// 1. Three branches (departments) and five programmes.
const deptSpecs = [
  ["CSE", "Computer Science & Engineering"],
  ["ECE", "Electronics & Communication"],
  ["MECH", "Mechanical Engineering"],
];
const departments = {};
for (const [code, name] of deptSpecs) {
  departments[code] = await call("POST", "/departments", {
    token: adminToken,
    body: { code, name },
    label: name,
  });
}
assert(Object.keys(departments).length === 3, "three departments created");

const programNames = [
  "B.Tech Computer Science",
  "B.Tech Electronics",
  "B.Tech Mechanical",
  "M.Tech Data Science",
  "MBA Technology Management",
];
const programs = [];
for (const name of programNames) {
  programs.push(
    await call("POST", "/departments/programs", { token: adminToken, body: { name }, label: name }),
  );
}
assert(programs.length === 5, "five programmes created");
const publicPrograms = await call("GET", "/auth/programs", { label: "public programme list" });
assert(publicPrograms.items.length === 5, "public registration sees all five programmes");

// 2. Three HODs, one per department.
const hods = [];
for (const [i, code] of ["CSE", "ECE", "MECH"].entries()) {
  const person = {
    email: `hod.${code.toLowerCase()}@northfield.edu`,
    fullName: ["Dr. Kavita Menon", "Dr. Arun Prasad", "Dr. Neha Kulkarni"][i],
    designation: "Head of Department",
    departmentId: departments[code].id,
    phone: `+91 98100 10${String(i).padStart(3, "0")}`,
    employeeCode: `HOD-${code}-01`,
    password: PASSWORD,
  };
  const staff = await setupStaff(adminToken, person);
  await call("POST", `/admin/users/${staff.user.id}/roles`, {
    token: adminToken,
    body: { role: "HOD_DEAN", scopeType: "DEPARTMENT", departmentId: departments[code].id },
    label: `HOD ${code}`,
  });
  hods.push({ ...person, ...staff, userId: staff.user.id, departmentCode: code });
}
assert(hods.length === 3, "three HODs provisioned, set up and scoped to their departments");

// 3. Ten faculty across the three departments.
const facultyNames = [
  "Prof. Rohan Deshpande",
  "Prof. Sneha Iyer",
  "Prof. Vikram Bhatt",
  "Prof. Priya Nair",
  "Prof. Kabir Shah",
  "Prof. Meghna Joshi",
  "Prof. Aditya Verma",
  "Prof. Tara Reddy",
  "Prof. Nikhil Bose",
  "Prof. Ishita Ghosh",
];
const faculty = [];
for (const [i, name] of facultyNames.entries()) {
  const code = ["CSE", "ECE", "MECH"][i % 3];
  const person = {
    email: `faculty.${i + 1}@northfield.edu`,
    fullName: name,
    designation: ["Assistant Professor", "Associate Professor"][i % 2],
    departmentId: departments[code].id,
    phone: `+91 98200 20${String(i).padStart(3, "0")}`,
    employeeCode: `FAC-${code}-${String(i + 1).padStart(2, "0")}`,
    password: PASSWORD,
  };
  const staff = await setupStaff(adminToken, person);
  await call("POST", `/admin/users/${staff.user.id}/roles`, {
    token: adminToken,
    body: { role: "FACULTY", scopeType: "DEPARTMENT", departmentId: departments[code].id },
    label: `FACULTY ${person.email}`,
  });
  faculty.push({ ...person, ...staff, userId: staff.user.id, departmentCode: code });
}
assert(
  faculty.length === 10,
  "ten faculty provisioned, activated and granted department-scoped FACULTY",
);

// 4. Seven college students for club leadership and two coordinators.
const students = [];
const studentNames = [
  "Aarav Sharma",
  "Diya Patel",
  "Reyansh Gupta",
  "Ananya Singh",
  "Vivaan Mehta",
  "Isha Kapoor",
  "Arjun Rao",
];
for (const [i, name] of studentNames.entries()) {
  const code = ["CSE", "CSE", "ECE", "MECH", "MECH", "CSE", "ECE"][i];
  const person = {
    email: `student.${i + 1}@northfield.edu`,
    fullName: name,
    phone: `+91 98765 43${String(i).padStart(3, "0")}`,
    institutionName: "Northfield Institute of Technology",
    rollNumber: `${code}2026${String(i + 1).padStart(3, "0")}`,
    departmentId: departments[code].id,
    program: programs[code === "CSE" ? 0 : code === "ECE" ? 1 : 2].name,
    graduationYear: 2028,
    collegeIdNumber: `NF-${code}-${1000 + i}`,
    password: PASSWORD,
    departmentCode: code,
  };
  await registerStudent("college", person);
  students.push(person);
}
assert(
  students.length === 7,
  "seven college students registered from the mobile flow and verified their email",
);

// 5. Five outside students.
const outsiders = [];
for (const [i, name] of [
  "Naina Verma",
  "Dev Malhotra",
  "Sara Khan",
  "Yash Thakur",
  "Mira Sen",
].entries()) {
  const person = {
    email: `outsider.${i + 1}@example.com`,
    fullName: name,
    phone: `+91 90000 30${String(i).padStart(3, "0")}`,
    institutionName: ["Delhi Technical Campus", "Amity School of Engineering", "VIT Vellore"][
      i % 3
    ],
    program: ["B.Tech IT", "B.Tech ECE", "BBA"][i % 3],
    graduationYear: 2027,
    password: PASSWORD,
  };
  await registerStudent("outsider", person);
  outsiders.push(person);
}
assert(outsiders.length === 5, "five outside students registered from the mobile flow");

// Log everyone in on the mobile client so the scenario can act as them.
for (const person of [...students, ...outsiders]) {
  const session = await login(person.email, person.password, "mobile");
  person.token = session.accessToken;
  person.refreshToken = session.refreshToken;
  person.userId = session.user.id;
}
console.log("SETUP COMPLETE");
console.log(JSON.stringify({ departments, programs, hods, faculty, students, outsiders }, null, 2));

import { writeFileSync } from "node:fs";
writeFileSync(
  process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname,
  JSON.stringify(
    { departments, programs, hods, faculty, students, outsiders, adminToken },
    null,
    2,
  ),
);
