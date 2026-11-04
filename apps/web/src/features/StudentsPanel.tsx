import { useCallback, useEffect, useState } from "react";
import { Modal, Pager, useToast } from "../components/feedback";
import { Card, Empty, Field, SkeletonRows, formatWhen } from "../components/ui";
import { type Page, api, errorMessage, query } from "../lib/api";
import { PAGE_SIZE } from "../lib/constants";
import { useSession } from "../lib/session";

type StudentRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  status: string;
  createdAt: string;
  departmentName: string | null;
  programName: string | null;
  profile: {
    studentKind: string;
    institutionName: string;
    rollNumber: string | null;
    departmentId: string | null;
    programId: string | null;
    program: string | null;
    studyYear: number | null;
    graduationYear: number | null;
    collegeIdNumber: string | null;
    verifiedAt: string | null;
    rejectionReason: string | null;
    profileVersion: number;
  };
};

type Department = { id: string; name: string };
type ProgramOption = {
  id: string;
  name: string;
  departmentName: string | null;
  foundationYears: number;
  durationYears: number;
  isActive: boolean;
};

const STATUSES = [
  "PENDING_EMAIL",
  "PENDING_VERIFICATION",
  "ACTIVE",
  "REJECTED",
  "SUSPENDED",
] as const;

function statusLabel(status: string) {
  return status.replace(/_/g, " ").toLowerCase();
}

export function StudentsPanel() {
  const { isAdmin, scopedDepartmentIds } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [programs, setPrograms] = useState<ProgramOption[]>([]);
  const [placement, setPlacement] = useState({ programId: "", studyYear: "" });
  const [savingPlacement, setSavingPlacement] = useState(false);
  const [filters, setFilters] = useState({ q: "", departmentId: "", status: "" });
  const [applied, setApplied] = useState({ q: "", departmentId: "", status: "" });
  const [detail, setDetail] = useState<StudentRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api<Page<StudentRow>>(
        `/faculty/students${query({
          limit: PAGE_SIZE,
          offset,
          q: applied.q || undefined,
          departmentId: applied.departmentId || undefined,
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
    Promise.all([
      api<{ items: Department[] }>("/departments"),
      api<{ items: ProgramOption[] }>("/departments/programs?includeInactive=true"),
    ])
      .then(([d, p]) => {
        setDepartments(d.items);
        setPrograms(p.items);
      })
      .catch(() => {});
  }, []);

  const deptName = (id: string | null, fallback: string | null) =>
    id ? (departments.find((d) => d.id === id)?.name ?? fallback ?? "—") : (fallback ?? "—");

  function openStudent(row: StudentRow) {
    setDetail(row);
    setPlacement({
      programId: row.profile.programId ?? "",
      studyYear: row.profile.studyYear ? String(row.profile.studyYear) : "",
    });
  }

  async function savePlacement() {
    if (!detail) return;
    const selected = programs.find((p) => p.id === placement.programId);
    if (selected && selected.foundationYears > 0 && !placement.studyYear) {
      toast.err("Choose a year of study so foundation-year membership is correct.");
      return;
    }
    setSavingPlacement(true);
    try {
      const result = await api<{ profile: StudentRow["profile"] }>(
        `/faculty/students/${detail.id}/profile`,
        {
          programId: placement.programId || null,
          studyYear: placement.studyYear ? Number(placement.studyYear) : null,
          program: selected?.name ?? null,
        },
        { method: "PATCH" },
      );
      const updated: StudentRow = {
        ...detail,
        profile: result.profile,
        programName: selected?.name ?? null,
        departmentName:
          departments.find((d) => d.id === result.profile.departmentId)?.name ??
          detail.departmentName,
      };
      setDetail(updated);
      setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      toast.ok("Programme placement updated. Department membership follows the new year.");
    } catch (err) {
      toast.err(errorMessage(err));
    } finally {
      setSavingPlacement(false);
    }
  }

  return (
    <>
      <Card
        title="Students"
        subtitle={
          isAdmin
            ? "Every student account in the institution."
            : "Students in the departments you head."
        }
        actions={
          <button
            type="button"
            className="ghost tiny"
            onClick={() => void load()}
            disabled={loading}
          >
            Refresh
          </button>
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
              placeholder="Name, email, roll number or phone"
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="Department">
            <select
              value={filters.departmentId}
              onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })}
            >
              <option value="">All departments</option>
              {departments
                .filter((d) => isAdmin || scopedDepartmentIds.includes(d.id))
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
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
          <Empty>No students match this filter.</Empty>
        ) : (
          <>
            <div className="scroll-x">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Roll number</th>
                    <th>Department</th>
                    <th>Programme</th>
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
                      <td className="meta">{row.profile.rollNumber ?? "—"}</td>
                      <td className="meta">
                        {deptName(row.profile.departmentId, row.departmentName)}
                      </td>
                      <td className="meta">
                        {row.programName ?? row.profile.program ?? "—"}
                        {row.profile.studyYear ? ` · year ${row.profile.studyYear}` : ""}
                      </td>
                      <td>
                        <span className={`badge ${row.status === "ACTIVE" ? "good" : "muted"}`}>
                          {statusLabel(row.status)}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ghost tiny"
                          onClick={() => openStudent(row)}
                        >
                          Open
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
        title={detail?.fullName ?? "Student"}
        description={detail?.email}
        onClose={() => setDetail(null)}
        footer={
          <button type="button" className="ghost" onClick={() => setDetail(null)}>
            Close
          </button>
        }
      >
        {detail && (
          <div className="stack">
            <dl className="kv">
              <dt>Status</dt>
              <dd>{statusLabel(detail.status)}</dd>
              <dt>Phone</dt>
              <dd>{detail.phone ?? "—"}</dd>
              <dt>Roll number</dt>
              <dd>{detail.profile.rollNumber ?? "—"}</dd>
              <dt>College ID</dt>
              <dd>{detail.profile.collegeIdNumber ?? "—"}</dd>
              <dt>Department</dt>
              <dd>{deptName(detail.profile.departmentId, detail.departmentName)}</dd>
              <dt>Programme</dt>
              <dd>{detail.programName ?? detail.profile.program ?? "—"}</dd>
              <dt>Year of study</dt>
              <dd>{detail.profile.studyYear ?? "—"}</dd>
              <dt>Graduation year</dt>
              <dd>{detail.profile.graduationYear ?? "—"}</dd>
              <dt>Institution</dt>
              <dd>{detail.profile.institutionName}</dd>
              <dt>Verified</dt>
              <dd>
                {detail.profile.verifiedAt ? formatWhen(detail.profile.verifiedAt) : "Not yet"}
              </dd>
              <dt>Profile version</dt>
              <dd>{detail.profile.profileVersion}</dd>
              {detail.profile.rejectionReason && (
                <>
                  <dt>Rejection reason</dt>
                  <dd>{detail.profile.rejectionReason}</dd>
                </>
              )}
            </dl>
            <div className="placement-editor">
              <h3>Programme placement</h3>
              <p className="hint">
                The year decides whether the student sits in a foundation department or their
                programme's home department. The rule comes from Administration → Departments, not
                from a fixed year number.
              </p>
              <div className="grid-2">
                <Field label="Programme">
                  <select
                    value={placement.programId}
                    onChange={(e) => setPlacement({ ...placement, programId: e.target.value })}
                  >
                    <option value="">No programme</option>
                    {programs
                      .filter((p) => p.isActive || p.id === placement.programId)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.departmentName ? ` · ${p.departmentName}` : ""}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Year of study" hint="Used to resolve foundation and home years.">
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={placement.studyYear}
                    onChange={(e) => setPlacement({ ...placement, studyYear: e.target.value })}
                  />
                </Field>
              </div>
              <button
                type="button"
                disabled={savingPlacement || !placement.programId}
                onClick={() => void savePlacement()}
              >
                {savingPlacement ? "Saving…" : "Save placement"}
              </button>
            </div>
            <p className="meta">
              Students manage their own contact details in the mobile app. Verification decisions
              live under Student verification.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
