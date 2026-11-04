import { GLOBAL_ROLE_LABELS } from "@campusops/shared/ui";
import { useState } from "react";
import { ConfirmDialog, useAction } from "../components/feedback";
import { Icon } from "../components/icons";
import { Card, Empty, Field } from "../components/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

/** Profile, roles and session security for the signed-in staff member. */
export function AccountPanel() {
  const { me, roles, signOut, reload } = useSession();
  const action = useAction();
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [confirmAll, setConfirmAll] = useState(false);

  if (!me) return null;

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pw.newPassword !== pw.confirm) return;
    await action.run(async () => {
      await api("/auth/change-password", {
        currentPassword: pw.currentPassword,
        newPassword: pw.newPassword,
      });
      setPw({ currentPassword: "", newPassword: "", confirm: "" });
      // The API revokes every session, including this one, so end it locally too
      // rather than leaving a screen whose next request would 401.
      await signOut(false);
      return "Password changed. Sign in again with your new password.";
    });
  }

  const mismatch = pw.confirm.length > 0 && pw.newPassword !== pw.confirm;
  const initials = me.user.fullName
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const roleNames = me.globalRoles.map(
    (r) => GLOBAL_ROLE_LABELS[r.role as keyof typeof GLOBAL_ROLE_LABELS] ?? r.role,
  );

  return (
    <>
      <Card title="Your account" subtitle="What the institution has on record for you.">
        <div className="account-identity">
          <span className="avatar account-avatar">{initials}</span>
          <div className="account-who">
            <b>{me.user.fullName}</b>
            <span>{me.user.email}</span>
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              {roleNames.length ? (
                roleNames.map((r) => (
                  <span className="badge info" key={r}>
                    {r}
                  </span>
                ))
              ) : (
                <span className="badge muted">Club membership only</span>
              )}
              <span className={`badge ${me.user.status === "ACTIVE" ? "good" : "warn"}`}>
                {me.user.status.replace(/_/g, " ").toLowerCase()}
              </span>
            </div>
          </div>
          <button type="button" className="ghost" onClick={() => reload()}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </div>

        <dl className="kv account-kv">
          <dt>Account type</dt>
          <dd>{me.user.accountType.replace(/_/g, " ").toLowerCase()}</dd>
          <dt>Sign-in email</dt>
          <dd>{me.user.email}</dd>
          <dt>Role source</dt>
          <dd>
            {me.globalRoles.length > 0
              ? me.globalRoles.some((r) => r.scopeType === "GLOBAL")
                ? "Institution-wide role assignment"
                : "Department-scoped role assignment"
              : "Club membership"}
          </dd>
          <dt>Active roles</dt>
          <dd>{roles.length ? roles.join(", ") : "None"}</dd>
        </dl>

        <h3>Institutional roles</h3>
        {me.globalRoles.length === 0 ? (
          <Empty icon="shield" title="No institutional role">
            Club coordinators manage events through their club membership. A HOD/Dean or the
            administrator grants staff roles.
          </Empty>
        ) : (
          <ul className="plain">
            {me.globalRoles.map((r) => (
              <li key={r.id}>
                <strong>
                  {GLOBAL_ROLE_LABELS[r.role as keyof typeof GLOBAL_ROLE_LABELS] ?? r.role}
                </strong>{" "}
                <span className="meta">
                  {r.scopeType === "GLOBAL" ? "institution-wide" : "department-scoped"}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3>Club memberships</h3>
        {me.clubMemberships.length === 0 ? (
          <Empty icon="users" title="No clubs">
            You are not attached to a club.
          </Empty>
        ) : (
          <ul className="plain">
            {me.clubMemberships.map((m) => (
              <li key={`${m.clubId}-${m.clubRole}`}>
                <strong>{m.clubName}</strong>{" "}
                <span className="meta">
                  {m.clubRole === "LEAD"
                    ? "Lead"
                    : m.clubRole === "FACULTY"
                      ? "Faculty"
                      : "Coordinator"}
                  {m.isActive ? "" : " · inactive"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="account-split">
        <Card
          title="Change password"
          subtitle="Changing it signs out every device, including this one."
        >
          <form className="form" onSubmit={changePassword} style={{ maxWidth: "none" }}>
            <Field label="Current password">
              <input
                type="password"
                required
                autoComplete="current-password"
                value={pw.currentPassword}
                onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
              />
            </Field>
            <Field label="New password" hint="At least 10 characters. A phrase is easier to keep.">
              <input
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                value={pw.newPassword}
                onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
              />
            </Field>
            <Field label="Confirm new password">
              <input
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                value={pw.confirm}
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
              />
            </Field>
            {mismatch && (
              <p className="bad-note">
                <Icon name="alert" size={15} />
                <span>The two new passwords do not match.</span>
              </p>
            )}
            <button type="submit" disabled={action.busy || mismatch || pw.newPassword.length < 10}>
              {action.busy ? "Changing…" : "Change password"}
            </button>
          </form>
        </Card>

        <div className="stack">
          <Card title="Sessions">
            <div className="row">
              <button type="button" className="ghost" onClick={() => signOut(false)}>
                <Icon name="logout" size={14} /> Sign out
              </button>
              <button type="button" className="danger" onClick={() => setConfirmAll(true)}>
                Sign out everywhere
              </button>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmAll}
        title="Sign out everywhere?"
        confirmLabel="Sign out everywhere"
        busy={action.busy}
        onCancel={() => setConfirmAll(false)}
        onConfirm={async () => {
          setConfirmAll(false);
          await signOut(true);
        }}
      />
    </>
  );
}
