import { useCallback, useEffect, useState } from "react";
import { FormDialog, useAction, useToast } from "../components/feedback";
import { Card, Empty, Field } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { StaffPanel } from "./StaffPanel";

type Department = { id: string; code: string; name: string };
type Sub = "staff" | "departments";

export function AdminPanel() {
  const [sub, setSub] = useState<Sub>("staff");
  return (
    <div className="stack">
      <div className="subtabs">
        {(
          [
            ["staff", "Staff"],
            ["departments", "Departments"],
          ] as Array<[Sub, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={sub === id ? "active" : "ghost"}
            onClick={() => setSub(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === "staff" && <StaffPanel />}
      {sub === "departments" && <DepartmentsSection />}
    </div>
  );
}

type Program = {
  id: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
  departmentCode: string | null;
  foundationDepartmentId: string | null;
  foundationYears: number;
  durationYears: number;
  isActive: boolean;
  students: number;
};

type ProgramDraft = {
  id?: string;
  name: string;
  departmentId: string;
  foundationDepartmentId: string;
  foundationYears: number;
  durationYears: number;
  isActive: boolean;
};

const emptyProgram = (departmentId = ""): ProgramDraft => ({
  name: "",
  departmentId,
  foundationDepartmentId: "",
  foundationYears: 0,
  durationYears: 4,
  isActive: true,
});

function foundationLabel(program: Program, departments: Department[]) {
  if (!program.foundationDepartmentId || program.foundationYears === 0) return null;
  const foundation = departments.find((d) => d.id === program.foundationDepartmentId);
  return `${foundation?.name ?? "Foundation department"} for year${
    program.foundationYears === 1 ? "" : "s"
  } 1–${program.foundationYears}`;
}

function DepartmentsSection() {
  const action = useAction();
  const toast = useToast();
  const [items, setItems] = useState<Department[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [form, setForm] = useState({ code: "", name: "" });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deptOpen, setDeptOpen] = useState(false);
  const [programDraft, setProgramDraft] = useState<ProgramDraft | null>(null);

  const load = useCallback(async () => {
    try {
      const [departmentResult, programResult] = await Promise.all([
        api<{ items: Department[] }>("/departments"),
        api<{ items: Program[] }>("/departments/programs?includeInactive=true"),
      ]);
      setItems(departmentResult.items);
      setPrograms(programResult.items);
    } catch (err) {
      toast.err(errorMessage(err));
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      await api("/departments", form);
      setForm({ code: "", name: "" });
      setDeptOpen(false);
      await load();
      return "Department created.";
    });
  }

  async function saveProgram(e: React.FormEvent) {
    e.preventDefault();
    if (!programDraft) return;
    const payload = {
      name: programDraft.name.trim(),
      departmentId: programDraft.departmentId,
      foundationDepartmentId: programDraft.foundationDepartmentId || null,
      foundationYears: programDraft.foundationDepartmentId ? programDraft.foundationYears : 0,
      durationYears: programDraft.durationYears,
      isActive: programDraft.isActive,
    };
    await action.run(async () => {
      if (programDraft.id)
        await api(`/departments/programs/${programDraft.id}`, payload, { method: "PATCH" });
      else await api("/departments/programs", payload);
      setProgramDraft(null);
      await load();
      return programDraft.id
        ? "Programme mapping updated. Current students were re-placed by year."
        : "Programme added and linked to its department.";
    });
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    await action.run(async () => {
      await api(`/departments/${renaming.id}`, { name: renaming.name }, { method: "PATCH" });
      setRenaming(null);
      await load();
      return "Department renamed.";
    });
  }

  const grouped = items.map((department) => ({
    department,
    programmes: programs.filter((p) => p.departmentId === department.id),
  }));
  const unassigned = programs.filter((p) => !p.departmentId);

  return (
    <>
      <Card
        title="Departments"
        actions={
          <button type="button" onClick={() => setDeptOpen(true)}>
            New department
          </button>
        }
      >
        <p className="meta">
          Departments scope role assignments, clubs, resources and student verification. A programme
          belongs to one home department, and can optionally spend its first years in a shared
          foundation department. Membership follows those settings, so no programme names or year
          bands are hardcoded.
        </p>
        {items.length === 0 ? (
          <Empty>No departments yet. Create one before adding programmes.</Empty>
        ) : (
          <div className="department-list">
            {grouped.map(({ department, programmes: list }) => (
              <section className="department-card" key={department.id}>
                <header>
                  <div>
                    <code className="badge">{department.code}</code>
                    <strong>{department.name}</strong>
                  </div>
                  <div className="row">
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() => setRenaming({ id: department.id, name: department.name })}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() => setProgramDraft(emptyProgram(department.id))}
                    >
                      Add programme
                    </button>
                  </div>
                </header>
                {list.length === 0 ? (
                  <p className="hint">No programmes assigned to this department yet.</p>
                ) : (
                  <ul className="programme-list">
                    {list.map((program) => {
                      const foundation = foundationLabel(program, items);
                      return (
                        <li key={program.id}>
                          <div>
                            <strong>{program.name}</strong>
                            {!program.isActive && <span className="badge">Inactive</span>}
                            <div className="hint">
                              {program.students} student{program.students === 1 ? "" : "s"}
                              {foundation
                                ? ` · ${foundation}`
                                : ` · ${program.durationYears}-year home department`}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="ghost tiny"
                            onClick={() =>
                              setProgramDraft({
                                id: program.id,
                                name: program.name,
                                departmentId: program.departmentId ?? "",
                                foundationDepartmentId: program.foundationDepartmentId ?? "",
                                foundationYears: program.foundationYears,
                                durationYears: program.durationYears,
                                isActive: program.isActive,
                              })
                            }
                          >
                            Edit
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
        {unassigned.length > 0 && (
          <section className="department-card unassigned">
            <header>
              <div>
                <strong>Unassigned programmes</strong>
              </div>
            </header>
            <p className="hint">
              These predate department mapping. Students cannot register into them until a home
              department is set.
            </p>
            <ul className="programme-list">
              {unassigned.map((program) => (
                <li key={program.id}>
                  <div>
                    <strong>{program.name}</strong>
                    <div className="hint">{program.students} student(s)</div>
                  </div>
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() =>
                      setProgramDraft({
                        id: program.id,
                        name: program.name,
                        departmentId: "",
                        foundationDepartmentId: program.foundationDepartmentId ?? "",
                        foundationYears: program.foundationYears,
                        durationYears: program.durationYears,
                        isActive: program.isActive,
                      })
                    }
                  >
                    Map it
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Card>

      <FormDialog
        open={deptOpen}
        title="New department"
        description="Codes are permanent because existing records reference them."
        submitLabel="Create department"
        busy={action.busy}
        onClose={() => setDeptOpen(false)}
        onSubmit={create}
      >
        <div className="grid-2">
          <Field label="Code">
            <input
              required
              minLength={2}
              maxLength={20}
              placeholder="CSE"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </Field>
          <Field label="Name">
            <input
              required
              minLength={2}
              placeholder="Computer Science and Engineering"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
        </div>
      </FormDialog>

      <FormDialog
        open={Boolean(programDraft)}
        title={programDraft?.id ? "Edit programme" : "Add a programme"}
        description="Choose the home department students graduate from, and optionally where the first years are taught."
        submitLabel={programDraft?.id ? "Save programme" : "Add programme"}
        busy={action.busy}
        size="wide"
        onClose={() => setProgramDraft(null)}
        onSubmit={saveProgram}
      >
        <div className="grid-2">
          <Field label="Programme name">
            <input
              required
              minLength={2}
              maxLength={120}
              value={programDraft?.name ?? ""}
              onChange={(e) => setProgramDraft((d) => (d ? { ...d, name: e.target.value } : d))}
              placeholder="B.Tech Computer Science"
            />
          </Field>
          <Field
            label="Home department"
            hint="The department students belong to after foundation years."
          >
            <select
              required
              value={programDraft?.departmentId ?? ""}
              onChange={(e) =>
                setProgramDraft((d) => (d ? { ...d, departmentId: e.target.value } : d))
              }
            >
              <option value="">Select department…</option>
              {items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Duration (years)">
            <input
              type="number"
              min={1}
              max={12}
              value={programDraft?.durationYears ?? 4}
              onChange={(e) =>
                setProgramDraft((d) => (d ? { ...d, durationYears: Number(e.target.value) } : d))
              }
            />
          </Field>
          <Field
            label="Foundation department"
            hint="Optional. Leave empty when every year belongs to the home department."
          >
            <select
              value={programDraft?.foundationDepartmentId ?? ""}
              onChange={(e) =>
                setProgramDraft((d) =>
                  d
                    ? {
                        ...d,
                        foundationDepartmentId: e.target.value,
                        foundationYears: e.target.value ? Math.max(1, d.foundationYears) : 0,
                      }
                    : d,
                )
              }
            >
              <option value="">None — all years in home department</option>
              {items
                .filter((d) => d.id !== programDraft?.departmentId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} — {d.name}
                  </option>
                ))}
            </select>
          </Field>
          {programDraft?.foundationDepartmentId && (
            <Field
              label="Foundation years"
              hint={`Year 1–${programDraft.foundationYears} belong to the foundation department; later years to the home department.`}
            >
              <input
                type="number"
                min={1}
                max={programDraft.durationYears}
                value={programDraft.foundationYears}
                onChange={(e) =>
                  setProgramDraft((d) =>
                    d ? { ...d, foundationYears: Number(e.target.value) } : d,
                  )
                }
              />
            </Field>
          )}
          {programDraft?.id && (
            <Field label="Registration">
              <select
                value={programDraft.isActive ? "active" : "inactive"}
                onChange={(e) =>
                  setProgramDraft((d) => (d ? { ...d, isActive: e.target.value === "active" } : d))
                }
              >
                <option value="active">Accepting registrations</option>
                <option value="inactive">Hidden from registration</option>
              </select>
            </Field>
          )}
        </div>
      </FormDialog>

      <FormDialog
        open={Boolean(renaming)}
        title="Rename department"
        submitLabel="Save name"
        busy={action.busy}
        onClose={() => setRenaming(null)}
        onSubmit={rename}
      >
        <Field label="Name">
          <input
            required
            minLength={2}
            value={renaming?.name ?? ""}
            onChange={(e) =>
              setRenaming((current) => (current ? { ...current, name: e.target.value } : null))
            }
          />
        </Field>
      </FormDialog>
    </>
  );
}
