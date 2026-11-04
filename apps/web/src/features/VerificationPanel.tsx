import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, FormDialog, Pager, useAction, useToast } from "../components/feedback";
import { Card, Empty, Field, formatWhen } from "../components/ui";
import { type Page, api, downloadBlob, errorMessage, isForbidden, query } from "../lib/api";
import { PAGE_SIZE } from "../lib/constants";
import { useSession } from "../lib/session";

type StudentRow = {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: string;
  profile: {
    rollNumber: string | null;
    institutionName: string;
    departmentId: string | null;
    program: string | null;
    graduationYear: number | null;
    photoFileId: string | null;
    idProofFileId: string | null;
    rejectionReason: string | null;
    profileVersion: number;
  };
};

type StudentDetail = {
  user: {
    id: string;
    email: string;
    fullName: string;
    phone: string | null;
    status: string;
    emailVerifiedAt: string | null;
  };
  profile: StudentRow["profile"];
};

type Department = { id: string; name: string };

/**
 * Faculty verify college student accounts. Students register in the mobile app;
 * this is the staff side of that flow. Only FACULTY may decide — HOD/Dean can
 * review the queue but the API restricts the decision itself to faculty.
 */
export function VerificationPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const { isFaculty } = useSession();
  const toast = useToast();
  const action = useAction();
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [reject, setReject] = useState<StudentDetail | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [edit, setEdit] = useState<{
    fullName: string;
    rollNumber: string;
    departmentId: string;
    program: string;
    graduationYear: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api<Page<StudentRow>>(
        `/faculty/verification-queue${query({ limit: PAGE_SIZE, offset })}`,
      );
      setRows(page.items);
      setHasMore(page.hasMore ?? false);
    } catch (err) {
      toast.err(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [offset, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ items: Department[] }>("/departments")
      .then((d) => setDepartments(d.items))
      .catch(() => {});
  }, []);

  const deptName = (id: string | null) =>
    id ? (departments.find((d) => d.id === id)?.name ?? "—") : "—";

  async function open(id: string) {
    await action.run(async () => {
      const d = await api<StudentDetail>(`/faculty/students/${id}`);
      setDetail(d);
      setEditOpen(false);
      setEdit({
        fullName: d.user.fullName,
        rollNumber: d.profile.rollNumber ?? "",
        departmentId: d.profile.departmentId ?? "",
        program: d.profile.program ?? "",
        graduationYear: d.profile.graduationYear ? String(d.profile.graduationYear) : "",
      });
    });
  }

  async function verify() {
    if (!detail) return;
    await action.run(async () => {
      await api(`/faculty/students/${detail.user.id}/verify`, {});
      setDetail(null);
      await load();
      onChanged?.();
      return "Student verified. They can now register for events.";
    });
  }

  async function doReject(reason: string) {
    if (!reject) return;
    await action.run(async () => {
      await api(`/faculty/students/${reject.user.id}/reject`, { reason });
      setReject(null);
      setDetail(null);
      await load();
      onChanged?.();
      return "Student rejected. The reason is visible to them.";
    });
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !edit) return;
    const ok = await action.run(async () => {
      await api(
        `/faculty/students/${detail.user.id}/profile`,
        {
          fullName: edit.fullName,
          rollNumber: edit.rollNumber || null,
          departmentId: edit.departmentId || null,
          program: edit.program || null,
          graduationYear: edit.graduationYear ? Number(edit.graduationYear) : null,
        },
        { method: "PATCH" },
      );
      await open(detail.user.id);
      return "Profile corrected.";
    });
    if (ok) setEditOpen(false);
  }

  async function openProof(fileId: string) {
    if (!detail) return;
    await action.run(async () => {
      // The proof is private: fetch it with the bearer token, then open the blob.
      const res = await api<{ url: string }>(
        `/faculty/students/${detail.user.id}/files/${fileId}/download`,
      );
      window.open(res.url, "_blank", "noopener,noreferrer");
    });
  }

  return (
    <>
      <Card title="Student verification queue">
        <p className="meta">
          College students register in the mobile app and appear here for verification. Only faculty
          can approve or reject; students cannot edit their own profile.
        </p>
        {!isFaculty && (
          <p className="warn-note">
            You can review this queue, but only a faculty role can verify or reject an account.
          </p>
        )}
        {loading ? (
          <p className="meta">Loading…</p>
        ) : rows.length === 0 ? (
          <Empty>No students are waiting for verification in your departments.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Roll no.</th>
                  <th>Phone</th>
                  <th>Department</th>
                  <th>Proof</th>
                  <th> </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>{s.fullName}</td>
                    <td className="meta">{s.email}</td>
                    <td>{s.profile.rollNumber ?? "—"}</td>
                    <td className="meta">{s.phone ?? "—"}</td>
                    <td className="meta">{deptName(s.profile.departmentId)}</td>
                    <td>{s.profile.idProofFileId ? "Uploaded" : "Missing"}</td>
                    <td>
                      <button type="button" className="ghost tiny" onClick={() => open(s.id)}>
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          offset={offset}
          limit={PAGE_SIZE}
          count={rows.length}
          hasMore={hasMore}
          onChange={setOffset}
        />
      </Card>

      {detail && (
        <Card
          title={`Review: ${detail.user.fullName}`}
          actions={
            <button type="button" className="ghost" onClick={() => setDetail(null)}>
              Close
            </button>
          }
        >
          <dl className="kv">
            <dt>Email</dt>
            <dd>
              {detail.user.email}{" "}
              {detail.user.emailVerifiedAt ? (
                <span className="chip">verified</span>
              ) : (
                <span className="chip">not verified</span>
              )}
            </dd>
            <dt>Phone</dt>
            <dd>{detail.user.phone ?? "—"}</dd>
            <dt>Status</dt>
            <dd>{detail.user.status.replace(/_/g, " ")}</dd>
            <dt>Institution</dt>
            <dd>{detail.profile.institutionName}</dd>
            <dt>Roll number</dt>
            <dd>{detail.profile.rollNumber ?? "—"}</dd>
            <dt>Department</dt>
            <dd>{deptName(detail.profile.departmentId)}</dd>
            <dt>Program</dt>
            <dd>{detail.profile.program ?? "—"}</dd>
            <dt>Graduation year</dt>
            <dd>{detail.profile.graduationYear ?? "—"}</dd>
            {detail.profile.rejectionReason && (
              <>
                <dt>Previous rejection</dt>
                <dd>{detail.profile.rejectionReason}</dd>
              </>
            )}
          </dl>

          {/* Identity documents are readable only by the faculty who may decide
              on the verification; the download route is FACULTY-only. */}
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            {!isFaculty && (
              <span className="hint">
                Identity documents and the verify/reject decision are restricted to faculty. You can
                review the submitted details here.
              </span>
            )}
            {isFaculty && detail.profile.idProofFileId ? (
              <button
                type="button"
                className="ghost"
                onClick={() => openProof(detail.profile.idProofFileId as string)}
              >
                Open college ID proof
              </button>
            ) : isFaculty ? (
              <span className="warn-note">No ID proof was uploaded.</span>
            ) : null}
            {isFaculty && detail.profile.photoFileId && (
              <button
                type="button"
                className="ghost"
                onClick={() => openProof(detail.profile.photoFileId as string)}
              >
                Open photo
              </button>
            )}
          </div>

          {isFaculty && (
            <>
              <div className="row" style={{ gap: "0.5rem", marginTop: "1rem" }}>
                <button
                  type="button"
                  disabled={action.busy || !detail.user.emailVerifiedAt}
                  onClick={verify}
                >
                  Verify student
                </button>
                <button type="button" className="danger" onClick={() => setReject(detail)}>
                  Reject
                </button>
                <button type="button" className="ghost" onClick={() => setEditOpen(true)}>
                  Correct profile
                </button>
              </div>
              {!detail.user.emailVerifiedAt && (
                <p className="hint">
                  The student must verify their email address before you can approve the account.
                </p>
              )}
            </>
          )}
        </Card>
      )}

      <FormDialog
        open={editOpen && edit !== null}
        title="Correct the student profile"
        description="Students cannot change these details themselves. Corrections are versioned and audited."
        submitLabel="Save corrections"
        busy={action.busy}
        onClose={() => setEditOpen(false)}
        onSubmit={saveProfile}
      >
        <div className="grid-2">
          <Field label="Full name">
            <input
              required
              minLength={2}
              value={edit?.fullName ?? ""}
              onChange={(e) => setEdit((v) => (v ? { ...v, fullName: e.target.value } : v))}
            />
          </Field>
          <Field label="Roll number">
            <input
              value={edit?.rollNumber ?? ""}
              onChange={(e) => setEdit((v) => (v ? { ...v, rollNumber: e.target.value } : v))}
            />
          </Field>
          <Field label="Department">
            <select
              value={edit?.departmentId ?? ""}
              onChange={(e) => setEdit((v) => (v ? { ...v, departmentId: e.target.value } : v))}
            >
              <option value="">None</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Program">
            <input
              value={edit?.program ?? ""}
              onChange={(e) => setEdit((v) => (v ? { ...v, program: e.target.value } : v))}
            />
          </Field>
          <Field label="Graduation year">
            <input
              type="number"
              min={2000}
              max={2100}
              value={edit?.graduationYear ?? ""}
              onChange={(e) => setEdit((v) => (v ? { ...v, graduationYear: e.target.value } : v))}
            />
          </Field>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={reject !== null}
        title={`Reject ${reject?.user.fullName ?? ""}?`}
        description="The student will see this reason and can correct their details and resubmit."
        confirmLabel="Reject account"
        reasonLabel="Reason"
        reasonRequired
        busy={action.busy}
        onCancel={() => setReject(null)}
        onConfirm={doReject}
      />
    </>
  );
}
