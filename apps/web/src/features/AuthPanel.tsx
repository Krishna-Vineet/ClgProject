import { type FormEvent, useState } from "react";
import { Icon } from "../components/icons";
import { Card, ErrorNote, Field, SuccessNote } from "../components/ui";
import { api, errorMessage } from "../lib/api";

type Config = {
  demoMode: boolean;
  emailMode: string | null;
  exposeDemoOtp: boolean;
  storageMode: string;
};
type Challenge = { challengeId: string; demoOtp?: string; delivery: string; expiresAt: string };

type Mode = "login" | "forgot" | "code";

const MODE_COPY: Record<Mode, { title: string; subtitle: string; submit: string }> = {
  login: {
    title: "Welcome back.",
    subtitle: "Sign in with the college email your institution has on record.",
    submit: "Sign in to the console",
  },
  forgot: {
    title: "Reset your password.",
    subtitle: "Enter your college email and we will send a six-digit code.",
    submit: "Send OTP",
  },
  code: {
    title: "Enter your reset code.",
    subtitle: "Use the code we emailed you, then choose a new password.",
    submit: "Reset password",
  },
};

/**
 * Staff sign-in for the management website.
 *
 * One decision at a time: the reset form only appears after the visitor asks for
 * it, and the code field only appears after the code request succeeds. Students do
 * not register here; they use the mobile app.
 */
export function AuthPanel({
  config,
  onAuthenticated,
}: {
  config: Config | null;
  onAuthenticated: (token: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  function resetTransientState() {
    setError(null);
    setNotice(null);
    setOtp("");
    setNewPassword("");
    setShowPw(false);
  }

  function goTo(next: Mode) {
    resetTransientState();
    if (next !== "code") setChallenge(null);
    setMode(next);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const normalized = email.trim().toLowerCase();
    try {
      if (mode === "login") {
        const r = await api<{ accessToken: string }>("/auth/login", {
          email: normalized,
          password,
          client: "web",
        });
        onAuthenticated(r.accessToken);
      } else if (mode === "forgot") {
        const r = await api<{ verification?: Challenge }>("/auth/forgot-password", {
          email: normalized,
        });
        if (r.verification) setChallenge(r.verification);
        setMode("code");
        setNotice("If that account exists, a reset code has been sent.");
      } else {
        // One endpoint serves both cases: a PASSWORD_RESET code resets an existing
        // password, a STAFF_SETUP code activates a new staff account and sets it.
        await api("/auth/reset-password", {
          email: normalized,
          otp: otp.trim(),
          newPassword,
        });
        setPassword("");
        setOtp("");
        setNewPassword("");
        setChallenge(null);
        setMode("login");
        setNotice("Password set. Sign in with your new password.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const copy = MODE_COPY[mode];

  return (
    <Card title={copy.title} subtitle={copy.subtitle}>
      <form className="form" onSubmit={submit}>
        {mode !== "code" && (
          <Field label="College email">
            <input
              name="email"
              type="email"
              required
              autoComplete="username"
              placeholder="you@institution.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        )}

        {mode === "login" && (
          <Field label="Password">
            <span className="input-group">
              <input
                name="password"
                type={showPw ? "text" : "password"}
                required
                autoComplete="current-password"
                aria-label="Password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="input-reveal"
                aria-label={showPw ? "Hide password" : "Show password"}
                onClick={() => setShowPw((v) => !v)}
              >
                <Icon name={showPw ? "eye-off" : "eye"} size={15} />
              </button>
            </span>
          </Field>
        )}

        {mode === "code" && (
          <>
            <Field label="6-digit code" hint="Check the inbox for your college email.">
              <input
                required
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="000000"
                className="otp-input"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field label="New password" hint="At least 10 characters. Longer is better.">
              <span className="input-group">
                <input
                  type={showPw ? "text" : "password"}
                  required
                  minLength={10}
                  autoComplete="new-password"
                  aria-label="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="input-reveal"
                  aria-label={showPw ? "Hide password" : "Show password"}
                  onClick={() => setShowPw((v) => !v)}
                >
                  <Icon name={showPw ? "eye-off" : "eye"} size={15} />
                </button>
              </span>
            </Field>
          </>
        )}

        <button type="submit" disabled={busy}>
          {busy ? (
            <>
              <span className="btn-spinner" aria-hidden="true" /> Working…
            </>
          ) : (
            <>
              {copy.submit} <Icon name="arrow-right" size={15} />
            </>
          )}
        </button>
      </form>

      {challenge?.demoOtp && config?.exposeDemoOtp && (
        <p className="note">
          <Icon name="info" size={15} />
          <span>
            Demo mode: your code is <strong>{challenge.demoOtp}</strong>. In production this arrives
            by email instead of on screen.
          </span>
        </p>
      )}

      <ErrorNote message={error} />
      <SuccessNote message={notice} />

      {mode === "login" && (
        <div className="auth-alt">
          <button type="button" className="ghost" onClick={() => goTo("forgot")}>
            Forgot password?
          </button>
        </div>
      )}
      {mode === "forgot" && (
        <div className="auth-alt">
          <button type="button" className="ghost" onClick={() => goTo("login")}>
            Back to sign in
          </button>
        </div>
      )}
      {mode === "code" && (
        <div className="auth-alt">
          <button type="button" className="ghost" onClick={() => goTo("forgot")}>
            Send a new code
          </button>
          <button type="button" className="ghost" onClick={() => goTo("login")}>
            Back to sign in
          </button>
        </div>
      )}

      {mode === "login" && (
        <p className="hint">
          No account yet? Staff accounts are created by an administrator, then activated with{" "}
          <strong>Forgot password?</strong>. Students should use the CampusOps mobile app.
        </p>
      )}
      {mode === "forgot" && (
        <p className="hint">
          For privacy, the same message is shown whether or not the address is registered.
        </p>
      )}
      {mode === "code" && (
        <p className="hint">
          One code works for both cases: a password reset, or activating a newly provisioned staff
          account. It expires shortly after it is issued.
        </p>
      )}
    </Card>
  );
}
