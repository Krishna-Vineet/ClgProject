import { effectiveEmailMode, env, isDevEmailMode, shouldExposeDemoOtp } from "../config/env";

export type DevEmail = { to: string; subject: string; actionUrl: string; otp: string };
const devOutbox: DevEmail[] = [];

export type AuthEmailInput = {
  to: string;
  subject: string;
  path: string;
  token: string;
  otp: string;
  ttlSeconds: number;
};

export async function sendAuthEmail(
  input: AuthEmailInput,
): Promise<{ demoOtp?: string; delivery: "DEMO" | "SENT" }> {
  const actionUrl = `${env.APP_BASE_URL}${input.path}?token=${encodeURIComponent(input.token)}`;
  const minutes = Math.ceil(input.ttlSeconds / 60);
  const text = `Your CampusOps code is ${input.otp}. It expires in ${minutes} minutes.\n\nOr open: ${actionUrl}\n\nIf you did not request this, ignore this email.`;
  if (isDevEmailMode()) {
    devOutbox.push({ to: input.to, subject: input.subject, actionUrl, otp: input.otp });
    // Do not log OTPs or action URLs. The UI receives the OTP only when explicitly enabled.
    console.log(`[demo-email] to=${input.to} subject=${input.subject}`);
    return { delivery: "DEMO", ...(shouldExposeDemoOtp() ? { demoOtp: input.otp } : {}) };
  }

  const mode = effectiveEmailMode();
  if (!mode)
    throw new Error(
      "EMAIL_MODE is not configured. Set EMAIL_MODE=demo with DEMO_MODE=true, or configure brevo/resend.",
    );
  if (mode === "brevo") {
    const key = env.BREVO_API_KEY ?? env.EMAIL_PROVIDER_API_KEY;
    const sender = parseSender(env.EMAIL_FROM);
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key ?? "", "content-type": "application/json" },
      body: JSON.stringify({
        sender,
        to: [{ email: input.to }],
        subject: input.subject,
        textContent: text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
      throw new Error(
        `Brevo failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    return { delivery: "SENT" };
  }
  const key = env.RESEND_API_KEY ?? env.EMAIL_PROVIDER_API_KEY;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [input.to], subject: input.subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw new Error(
      `Resend failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`,
    );
  return { delivery: "SENT" };
}

function parseSender(from: string): { name?: string; email: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match?.[2]) return match[1] ? { name: match[1], email: match[2] } : { email: match[2] };
  return { email: from.trim() };
}

export function getDevOutbox(): readonly DevEmail[] {
  return devOutbox;
}

export type NotificationEmailInput = { to: string; subject: string; text: string };

/**
 * Operational email (approval requests, decisions, escalations).
 * Demo mode logs metadata only. With no provider configured the outbox row is
 * marked SKIPPED rather than silently pretending to send.
 */
export async function deliverNotificationEmail(
  input: NotificationEmailInput,
): Promise<"DEMO" | "SENT" | "SKIPPED"> {
  if (isDevEmailMode()) {
    console.log(`[demo-email] to=${input.to} subject=${input.subject}`);
    return "DEMO";
  }
  const mode = effectiveEmailMode();
  if (!mode) return "SKIPPED";
  if (mode === "brevo") {
    const key = env.BREVO_API_KEY ?? env.EMAIL_PROVIDER_API_KEY;
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key ?? "", "content-type": "application/json" },
      body: JSON.stringify({
        sender: parseSender(env.EMAIL_FROM),
        to: [{ email: input.to }],
        subject: input.subject,
        textContent: input.text,
      }),
    });
    if (!res.ok)
      throw new Error(
        `Brevo failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    return "SENT";
  }
  const key = env.RESEND_API_KEY ?? env.EMAIL_PROVIDER_API_KEY;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [input.to],
      subject: input.subject,
      text: input.text,
    }),
  });
  if (!res.ok)
    throw new Error(
      `Resend failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`,
    );
  return "SENT";
}
