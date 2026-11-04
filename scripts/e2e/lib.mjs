export const BASE = process.env.SCENARIO_BASE ?? "http://127.0.0.1:8787/api/v1";
export const STATE_FILE =
  process.env.SCENARIO_STATE ?? new URL("./state.json", import.meta.url).pathname;
export const log = [];
export const state = {};

export async function call(method, path, { token, body, headers = {}, expect, label } = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const expected = expect ?? [200, 201];
  const ms = Date.now() - started;
  const okStatus = expected.includes(res.status);
  console.log(
    `${okStatus ? "✓" : "✗"} ${String(res.status).padEnd(3)} ${method} ${path} ${label ?? ""} (${ms}ms)`,
  );
  log.push({ method, path, status: res.status, ms, label });
  if (!okStatus) {
    console.error("  response:", text.slice(0, 1200));
    throw new Error(`${method} ${path} -> ${res.status}`);
  }
  return json?.data ?? json;
}

export async function login(email, password, client = "web") {
  const result = await call("POST", "/auth/login", {
    body: {
      email,
      password,
      client,
      ...(client === "mobile" ? { deviceLabel: "Scenario phone" } : {}),
    },
    label: email,
  });
  return result;
}

export async function setupStaff(adminToken, person) {
  const created = await call("POST", "/admin/staff", {
    token: adminToken,
    headers: { "idempotency-key": `staff-${person.email}` },
    body: {
      email: person.email,
      fullName: person.fullName,
      designation: person.designation,
      departmentId: person.departmentId,
      phone: person.phone,
      employeeCode: person.employeeCode,
    },
    label: person.email,
  });
  const forgot = await call("POST", "/auth/forgot-password", {
    body: { email: person.email },
    label: `setup mail ${person.email}`,
  });
  const otp = forgot.verification?.demoOtp;
  if (!otp) throw new Error(`No demo OTP for ${person.email}; is DEMO_MODE/EXPOSE_DEMO_OTP on?`);
  await call("POST", "/auth/reset-password", {
    body: { email: person.email, otp, newPassword: person.password },
    label: "staff setup",
  });
  const session = await login(person.email, person.password);
  return { user: created.user, token: session.accessToken, refreshToken: session.refreshToken };
}

export async function registerStudent(kind, person) {
  const path = kind === "college" ? "/auth/register/college" : "/auth/register/outsider";
  const result = await call("POST", path, {
    headers: { "idempotency-key": `register-${person.email}` },
    body: {
      email: person.email,
      password: person.password,
      fullName: person.fullName,
      phone: person.phone,
      institutionName: person.institutionName,
      client: "mobile",
      ...(kind === "college"
        ? {
            rollNumber: person.rollNumber,
            departmentId: person.departmentId,
            program: person.program,
            graduationYear: person.graduationYear,
            collegeIdNumber: person.collegeIdNumber,
          }
        : { program: person.program, graduationYear: person.graduationYear }),
    },
    label: `${kind} ${person.email}`,
  });
  const otp = result.verification?.demoOtp;
  if (!otp) throw new Error(`No demo OTP for student ${person.email}`);
  await call("POST", "/auth/verify-email", {
    body: { challengeId: result.verification.challengeId, otp },
    label: "verify email",
  });
  return result;
}

export function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
  console.log(`  ✓ ${message}`);
}
