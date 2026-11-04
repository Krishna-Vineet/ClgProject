import {
  GLOBAL_ROLES,
  GLOBAL_ROLE_LABELS,
  STAFF_POSITIONS,
  STAFF_POSITION_LABELS,
  type StaffPosition,
} from "@campusops/shared/ui";
import { useCallback, useEffect, useState } from "react";
import {
  ConfirmDialog,
  FormDialog,
  Modal,
  Pager,
  useAction,
  useToast,
} from "../components/feedback";
import { Card, Empty, Field, SkeletonRows, formatWhen } from "../components/ui";
import { type Page, api, errorMessage, query } from "../lib/api";
import { PAGE_SIZE } from "../lib/constants";
import { useSession } from "../lib/session";

type StaffRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  status: string;
  createdAt: string;
  departmentId: string | null;
  departmentName: string | null;
  designation: string;
  position: StaffPosition;
  roles: string[];
};

type Department = { id: string; code: string; name: string };

type RoleRow = {
  id: string;
  role: string;
  scopeType: string;
  departmentId: string | null;
  isActive: boolean;
};

type StaffDetail = {
  user: {
    id: string;
    email: string;
    fullName: string;
    phone: string | null;
    status: string;
    emailVerifiedAt: string | null;
    createdAt: string;
  };
  staffProfile: {
    designation: string;
    position: StaffPosition;
    employeeCode: string | null;
    departmentId: string | null;
  } | null;
  roles: RoleRow[];
};

const STATUSES = ["PENDING_EMAIL", "PENDING_VERIFICATION", "ACTIVE", "REJECTED", "SUSPENDED"];

function statusLabel(status: string) {
  return status.replace(/_/g, " ").toLowerCase();
}

export function StaffPanel() {
  const session = useSession();
  const me = session.me;
  const toast = useToast();
  const action = useAction();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [filters, setFilters] = useState({ q: "", departmentId: "", position: "", status: "" });
  const [applied, setApplied] = useState({ q: "", departmentId: "", position: "", status: "" });
  const [providing, setProviding] = useState(false);
  const [form, setForm] = useState({
    email: "",
    fullName: "",
    phone: "",
    position: "" as StaffPosition | "",
    departmentId: "",
  });
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [grant, setGrant] = useState({
    role: "FACULTY",
    scopeType: "DEPARTMENT",
    departmentId: "",
  });
  const [confirm, setConfirm] = useState<{
    kind: "suspend" | "reactivate" | "revoke";
    id: string;
    label: string;
  } | null>(null);
  /**
   * An HOD/Dean opens this panel for one department: the API narrows every read
   * and refuses structural edits, so the UI hides what would only 403 — and says
   * whose department is on screen, so nobody mistakes it for the whole college.
   */
  const isInstitutionAdmin = session.isAdmin;
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [edit, setEdit] = useState({ fullName: "", phone: "", email: "" });
  const [savingEdit, setSavingEdit] = useState(false);

  function openEdit(row: StaffRow) {
    setEdit({ fullName: row.fullName, phone: row.phone ?? "", email: row.email });
    setEditing(row);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSavingEdit(true);
    try {
      const result = await api<{
        emailChanged: boolean;
        emailVerificationRequired: boolean;
      }>(
        `/admin/staff/${editing.id}`,
        {
          fullName: edit.fullName.trim(),
          phone: edit.phone.trim() === "" ? null : edit.phone.trim(),
          ...(isInstitutionAdmin ? { email: edit.email.trim() } : {}),
        },
        { method: "PATCH" },
      );
      setEditing(null);
      await load();
      toast.ok(
        result.emailVerificationRequired
          ? "Saved. The new address must be confirmed before that account can sign in again."
          : "Staff details saved.",
      );
    } catch (err) {
      toast.err(errorMessage(err));
    } finally {
      setSavingEdit(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api<Page<StaffRow>>(
        `/admin/staff${query({
          limit: PAGE_SIZE,
          offset,
          q: applied.q || undefined,
          departmentId: applied.departmentId || undefined,
          position: applied.position || undefined,
          status: applied.status || undefined,
        })}`,
      );
      setRows(page.items);
      setTotal(page.total ?? page.items.length);
    } catch (err) {
      toast.err(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [offset, applied, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<{ items: Department[] }>("/departments")
      .then((d) => setDepartments(d.items))
      .catch(() => {});
  }, []);

  // An HOD/Dean has no business filtering by a department that is not theirs;
  // the API would refuse it, so the option is removed rather than left to fail.
  const visibleDepartments = session.isAdmin
    ? departments
    : departments.filter((d) => session.scopedDepartmentIds.includes(d.id));

  async function openStaff(id: string) {
    await action.run(async () => {
      setDetail(await api<StaffDetail>(`/admin/users/${id}`));
    });
  }

  async function refreshDetail(id: string) {
    setDetail(await api<StaffDetail>(`/admin/users/${id}`));
    await load();
  }

  async function addStaff(e: React.FormEvent) {
    e.preventDefault();
    if (!form.position) return;
    let createdId = "";
    const ok = await action.run(async () => {
      const res = await api<{ user: { id: string } }>("/admin/staff", {
        email: form.email,
        fullName: form.fullName,
        phone: form.phone,
        position: form.position,
        departmentId: form.departmentId === "INSTITUTION_WIDE" ? null : form.departmentId,
      });
      createdId = res.user.id;
      setProviding(false);
      setForm({ email: "", fullName: "", phone: "", position: "", departmentId: "" });
      await load();
      return "Staff added. They can use Forgot password to set a password.";
    });
    if (ok && createdId) await openStaff(createdId);
  }

  async function grantRole(e: React.FormEvent) {
    e.preventDefault();
    if (!detail) return;
    const ok = await action.run(async () => {
      await api(`/admin/users/${detail.user.id}/roles`, {
        role: grant.role,
        scopeType: grant.scopeType,
        ...(grant.scopeType === "DEPARTMENT" ? { departmentId: grant.departmentId } : {}),
      });
      await refreshDetail(detail.user.id);
      return "Role granted.";
    });
    if (ok) {
      setGrantOpen(false);
      setGrant({ role: "FACULTY", scopeType: "DEPARTMENT", departmentId: "" });
    }
  }

  async function runConfirm(reason: string) {
    if (!confirm) return;
    const target = confirm;
    await action.run(async () => {
      if (target.kind === "revoke") {
        if (!detail) return;
        await api(`/admin/users/${detail.user.id}/roles/${target.id}`, undefined, {
          method: "DELETE",
        });
        await refreshDetail(detail.user.id);
        setConfirm(null);
        return "Role revoked.";
      }
      await api(`/admin/users/${target.id}/${target.kind}`, { reason });
      if (detail?.user.id === target.id) await refreshDetail(target.id);
      else await load();
      setConfirm(null);
      return target.kind === "suspend" ? "Account suspended." : "Account reactivated.";
    });
  }

  const deptName = (id: string | null, fallback?: string | null) =>
    id ? (departments.find((d) => d.id === id)?.name ?? fallback ?? "—") : "Institution-wide";

  return (
    <>
      <Card
        title="Staff"
        subtitle="Departments, positions and contact details. Access roles are granted separately."
        actions={
          isInstitutionAdmin ? (
            <button type="button" onClick={() => setProviding(true)}>
              Add staff
            </button>
          ) : null
        }
      >
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied(filters);
          }}
        >
          <Field label="Search">
            <input
              value={filters.q}
              placeholder="Name, email or phone"
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="Department">
            <select
              value={filters.departmentId}
              onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })}
            >
              <option value="">All departments</option>
              {visibleDepartments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Position">
            <select
              value={filters.position}
              onChange={(e) => setFilters({ ...filters, position: e.target.value })}
            >
              <option value="">All positions</option>
              {STAFF_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {STAFF_POSITION_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className="ghost">
            Apply filters
          </button>
        </form>

        {loading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <Empty>No staff match this filter.</Empty>
        ) : (
          <>
            <div className="scroll-x">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Department</th>
                    <th>Position</th>
                    <th>Status</th>
                    <th> </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.fullName}
                        <div className="meta">{row.email}</div>
                      </td>
                      <td className="meta nowrap">{row.phone ?? "—"}</td>
                      <td className="meta">{deptName(row.departmentId, row.departmentName)}</td>
                      <td>
                        <span className="chip">{STAFF_POSITION_LABELS[row.position]}</span>
                      </td>
                      <td>
                        <span className={`badge ${row.status === "ACTIVE" ? "good" : "muted"}`}>
                          {statusLabel(row.status)}
                        </span>
                      </td>
                      <td className="row-actions">
                        <button type="button" className="ghost tiny" onClick={() => openEdit(row)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ghost tiny"
                          onClick={() => openStaff(row.id)}
                        >
                          Manage
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              offset={offset}
              limit={PAGE_SIZE}
              count={rows.length}
              total={total}
              onChange={setOffset}
            />
          </>
        )}
      </Card>

      <Modal
        open={detail !== null}
        size="lg"
        title={detail?.user.fullName ?? "Staff member"}
        description={detail?.user.email}
        onClose={() => setDetail(null)}
        footer={
          <>
            {detail && (
              <button type="button" className="ghost" onClick={() => setGrantOpen(true)}>
                Grant role
              </button>
            )}
            {detail &&
              (detail.user.status === "SUSPENDED" ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    setConfirm({
                      kind: "reactivate",
                      id: detail.user.id,
                      label: detail.user.fullName,
                    })
                  }
                >
                  Reactivate
                </button>
              ) : detail.user.id !== me?.user.id ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    setConfirm({
                      kind: "suspend",
                      id: detail.user.id,
                      label: detail.user.fullName,
                    })
                  }
                >
                  Suspend
                </button>
              ) : null)}
            <button type="button" className="ghost" onClick={() => setDetail(null)}>
              Close
            </button>
          </>
        }
      >
        {detail && (
          <div className="stack">
            <dl className="kv">
              <dt>Phone</dt>
              <dd>{detail.user.phone ?? "—"}</dd>
              <dt>Department</dt>
              <dd>{deptName(detail.staffProfile?.departmentId ?? null)}</dd>
              <dt>Position</dt>
              <dd>
                {detail.staffProfile ? STAFF_POSITION_LABELS[detail.staffProfile.position] : "—"}
              </dd>
              <dt>Designation</dt>
              <dd>{detail.staffProfile?.designation ?? "—"}</dd>
              <dt>Status</dt>
              <dd>{statusLabel(detail.user.status)}</dd>
              <dt>Email verified</dt>
              <dd>
                {detail.user.emailVerifiedAt ? formatWhen(detail.user.emailVerifiedAt) : "No"}
              </dd>
              <dt>Added</dt>
              <dd>{formatWhen(detail.user.createdAt)}</dd>
            </dl>

            <h3>Access roles</h3>
            {detail.roles.length === 0 ? (
              <Empty>No institutional roles. This account has no staff powers.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Scope</th>
                      <th>Active</th>
                      <th> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.roles.map((r) => (
                      <tr key={r.id}>
                        <td>
                          {GLOBAL_ROLE_LABELS[r.role as keyof typeof GLOBAL_ROLE_LABELS] ?? r.role}
                        </td>
                        <td className="meta">
                          {r.scopeType === "GLOBAL" ? "Institution-wide" : deptName(r.departmentId)}
                        </td>
                        <td>{r.isActive ? "Yes" : "No"}</td>
                        <td>
                          <button
                            type="button"
                            className="ghost tiny"
                            onClick={() => setConfirm({ kind: "revoke", id: r.id, label: r.role })}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>

      <FormDialog
        open={editing !== null}
        title="Edit staff details"
        description={
          isInstitutionAdmin
            ? "Changing the email pauses the account until the new address is confirmed."
            : "You can correct name, phone and email for staff in your department."
        }
        submitLabel="Save changes"
        busy={savingEdit}
        onClose={() => setEditing(null)}
        onSubmit={saveEdit}
      >
        <div className="grid-2">
          <Field label="Full name">
            <input
              required
              minLength={2}
              value={edit.fullName}
              onChange={(e) => setEdit({ ...edit, fullName: e.target.value })}
            />
          </Field>
          <Field label="Phone" hint="Leave blank to clear the number.">
            <input
              value={edit.phone}
              onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
            />
          </Field>
        </div>
        <Field
          label="Email"
          hint={
            isInstitutionAdmin
              ? "Used to sign in. A change revokes existing sessions."
              : "Only an administrator can change the sign-in address."
          }
        >
          <input
            type="email"
            required
            disabled={!isInstitutionAdmin}
            value={edit.email}
            onChange={(e) => setEdit({ ...edit, email: e.target.value })}
          />
        </Field>
      </FormDialog>

      <FormDialog
        open={providing}
        title="Add staff"
        description="Creates an account without a password. The holder uses Forgot password to set one."
        submitLabel="Add staff"
        size="lg"
        busy={action.busy}
        onClose={() => setProviding(false)}
        onSubmit={addStaff}
      >
        <div className="grid-2">
          <Field label="Email">
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Full name">
            <input
              required
              minLength={2}
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </Field>
          <Field label="Phone number">
            <input
              type="tel"
              required
              placeholder="+91 98765 43210"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="Position">
            <select
              required
              value={form.position}
              onChange={(e) => setForm({ ...form, position: e.target.value as StaffPosition | "" })}
            >
              <option value="" disabled>
                Choose a position…
              </option>
              {STAFF_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {STAFF_POSITION_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Department" hint="Required. Use Institution-wide for central staff.">
            <select
              required
              value={form.departmentId}
              onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
            >
              <option value="" disabled>
                Choose a department…
              </option>
              <option value="INSTITUTION_WIDE">Institution-wide</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </FormDialog>

      <FormDialog
        open={grantOpen}
        title="Grant a role"
        description="Positions describe the job. Roles grant access. Admin is always institution-wide."
        submitLabel="Grant role"
        busy={action.busy}
        onClose={() => setGrantOpen(false)}
        onSubmit={grantRole}
      >
        <Field label="Role">
          <select
            value={grant.role}
            onChange={(e) =>
              setGrant({
                ...grant,
                role: e.target.value,
                scopeType: e.target.value === "ADMIN" ? "GLOBAL" : grant.scopeType,
              })
            }
          >
            {GLOBAL_ROLES.map((r) => (
              <option key={r} value={r}>
                {GLOBAL_ROLE_LABELS[r] ?? r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scope">
          <select
            value={grant.scopeType}
            disabled={grant.role === "ADMIN"}
            onChange={(e) => setGrant({ ...grant, scopeType: e.target.value })}
          >
            <option value="DEPARTMENT">One department</option>
            <option value="GLOBAL">Institution-wide</option>
          </select>
        </Field>
        {grant.scopeType === "DEPARTMENT" && (
          <Field label="Department">
            <select
              required
              value={grant.departmentId}
              onChange={(e) => setGrant({ ...grant, departmentId: e.target.value })}
            >
              <option value="">Choose…</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </FormDialog>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "suspend"
            ? `Suspend ${confirm.label}?`
            : confirm?.kind === "reactivate"
              ? `Reactivate ${confirm.label}?`
              : `Revoke ${confirm?.label ?? ""}?`
        }
        description={
          confirm?.kind === "suspend"
            ? "This signs the account out everywhere and blocks access until it is reactivated."
            : confirm?.kind === "reactivate"
              ? "The account will be able to sign in again."
              : "The account immediately loses the powers this role grants."
        }
        confirmLabel={confirm?.kind === "revoke" ? "Revoke role" : "Confirm"}
        reasonLabel={confirm?.kind === "revoke" ? undefined : "Reason"}
        reasonRequired={confirm?.kind !== "revoke"}
        busy={action.busy}
        onCancel={() => setConfirm(null)}
        onConfirm={runConfirm}
      />
    </>
  );
}
