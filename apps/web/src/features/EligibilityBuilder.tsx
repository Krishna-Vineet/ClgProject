import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, type AccountType } from "@campusops/shared/ui";
import { Icon } from "../components/icons";
import { Field } from "../components/ui";

/**
 * The one "who may register" control.
 *
 * It used to exist twice — a simpler audience/admission pair on the create form
 * and this rule builder in the workspace — so a coordinator answered the same
 * question in two different vocabularies depending on which screen they were on,
 * and the quiz screen added a third place to think about it. There is one
 * question ("who is this for?") and one component. Anywhere that needs it renders
 * this, with the same words.
 */
export type EligibilityPolicy = {
  version: 1;
  accountTypes: AccountType[];
  departmentIds: string[];
  graduationYears: number[];
  requireInvitation: boolean;
};

export type Audience = "COLLEGE_ONLY" | "OUTSIDERS_ALLOWED" | "INVITED_ONLY";

export const AUDIENCE_LABELS: Record<Audience, string> = {
  COLLEGE_ONLY: "Students of this college only",
  OUTSIDERS_ALLOWED: "Anyone, including other colleges",
  INVITED_ONLY: "Only people you invite",
};

const AUDIENCE_HINTS: Record<Audience, string> = {
  COLLEGE_ONLY: "Outside students cannot see this event at all.",
  OUTSIDERS_ALLOWED:
    "Visitors from other colleges can apply. Their department and graduation year are unknown, so those rules do not apply to them — you accept each visitor yourself.",
  INVITED_ONLY: "The event is hidden until you invite someone by email.",
};

/** "2026, 2027", "2026 2027", "2026,2027" → [2026, 2027]. */
export function parseYears(text: string): number[] {
  return [
    ...new Set(
      text
        .split(/[^0-9]+/)
        .map((part) => Number(part))
        .filter((n) => Number.isInteger(n) && n >= 2000 && n <= 2100),
    ),
  ].sort();
}

export function EligibilityBuilder({
  audience,
  policy,
  departments,
  yearsText,
  disabled,
  showAudience = true,
  onChange,
}: {
  audience: Audience;
  policy: EligibilityPolicy;
  departments: Array<{ id: string; code: string; name: string }>;
  /** Kept in the parent because it is what the user is literally typing. */
  yearsText: string;
  disabled?: boolean;
  showAudience?: boolean;
  onChange: (next: { audience?: Audience; policy?: EligibilityPolicy }) => void;
}) {
  const setPolicy = (patch: Partial<EligibilityPolicy>) =>
    onChange({ policy: { ...policy, ...patch } });

  const toggle = <T,>(list: T[], value: T, on: boolean): T[] =>
    on ? list.filter((x) => x !== value) : [...list, value];

  // A visitor has no department and no batch, so restricting by either would be
  // refusing them for information the product never asks them for. Say so here
  // rather than letting the organiser discover it from a student's complaint.
  const campusOnlyRulesIgnored = audience !== "COLLEGE_ONLY";

  return (
    <fieldset className="span-2 eligibility-builder">
      <legend>Who may register</legend>
      <p className="hint">
        This is the only place registration access is decided. The server applies it the moment
        someone taps Register, and the Quiz screen reads it from here.
      </p>

      {showAudience && (
        <div className="eligibility-group">
          <span className="eligibility-label">Audience</span>
          <div className="chip-toggle-row">
            {(Object.keys(AUDIENCE_LABELS) as Audience[]).map((value) => {
              const on = audience === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  className={on ? "chip-toggle active" : "chip-toggle"}
                  onClick={() => onChange({ audience: value })}
                >
                  {on ? <Icon name="check" size={12} /> : null}
                  {AUDIENCE_LABELS[value]}
                </button>
              );
            })}
          </div>
          <small className="hint">{AUDIENCE_HINTS[audience]}</small>
        </div>
      )}

      <div className="eligibility-group">
        <span className="eligibility-label">Account type</span>
        <div className="chip-toggle-row">
          {ACCOUNT_TYPES.map((t) => {
            const on = policy.accountTypes.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                className={on ? "chip-toggle active" : "chip-toggle"}
                onClick={() => setPolicy({ accountTypes: toggle(policy.accountTypes, t, on) })}
              >
                {on ? <Icon name="check" size={12} /> : null}
                {ACCOUNT_TYPE_LABELS[t]}
              </button>
            );
          })}
        </div>
        <small className="hint">
          {policy.accountTypes.length === 0
            ? "No restriction — every account type the audience allows may register."
            : `Only ${policy.accountTypes
                .map((t) => ACCOUNT_TYPE_LABELS[t].toLowerCase())
                .join(", ")} may register.`}
        </small>
      </div>

      <div className={`eligibility-group${campusOnlyRulesIgnored ? " is-muted" : ""}`}>
        <span className="eligibility-label">Departments</span>
        <div className="chip-toggle-row">
          <button
            type="button"
            aria-pressed={policy.departmentIds.length === 0}
            disabled={disabled}
            className={policy.departmentIds.length === 0 ? "chip-toggle active" : "chip-toggle"}
            onClick={() => setPolicy({ departmentIds: [] })}
          >
            Any department
          </button>
          {departments.map((d) => {
            const on = policy.departmentIds.includes(d.id);
            return (
              <button
                key={d.id}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                className={on ? "chip-toggle active" : "chip-toggle"}
                onClick={() => setPolicy({ departmentIds: toggle(policy.departmentIds, d.id, on) })}
              >
                {on ? <Icon name="check" size={12} /> : null}
                {d.code}
              </button>
            );
          })}
        </div>
        {campusOnlyRulesIgnored && policy.departmentIds.length > 0 && (
          <small className="hint warn">
            Visitors from other colleges have no department, so this rule will not stop them. They
            are held for your approval instead.
          </small>
        )}
      </div>

      <div className={`eligibility-group${campusOnlyRulesIgnored ? " is-muted" : ""}`}>
        <span className="eligibility-label">Graduation years</span>
        <Field
          label="Years"
          hint="Comma or space separated, e.g. 2026, 2027. Empty means any year."
        >
          <input
            inputMode="numeric"
            disabled={disabled}
            value={yearsText}
            placeholder="2026, 2027"
            // The typed text stays in the parent so the cursor never jumps; the
            // parsed years are what the policy actually stores.
            onChange={(e) =>
              onChange({ policy: { ...policy, graduationYears: parseYears(e.target.value) } })
            }
          />
        </Field>
        {policy.graduationYears.length > 0 && (
          <div className="chip-toggle-row">
            {policy.graduationYears.map((year) => (
              <span key={year} className="chip">
                {year}
              </span>
            ))}
          </div>
        )}
        {campusOnlyRulesIgnored && policy.graduationYears.length > 0 && (
          <small className="hint warn">
            Visitors do not have a graduation year on file, so this rule will not stop them.
          </small>
        )}
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          disabled={disabled}
          checked={policy.requireInvitation}
          onChange={(e) => setPolicy({ requireInvitation: e.target.checked })}
        />
        Require a personal invitation to register
      </label>
    </fieldset>
  );
}
