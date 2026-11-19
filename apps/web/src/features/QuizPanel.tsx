import {
  QUIZ_MODE_DESCRIPTIONS,
  QUIZ_MODE_LABELS,
  QUIZ_STATUS_LABELS,
  type QuizMode,
  type QuizStatus,
} from "@campusops/shared/ui";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, Loading, useAction, useToast } from "../components/feedback";
import {
  Card,
  Empty,
  Field,
  formatWhen,
  fromLocalInput,
  toLocalInput,
  useNotice,
} from "../components/ui";
import { api, errorMessage } from "../lib/api";
import type { EventRow } from "../lib/types";

type Question = {
  prompt: string;
  options: string[];
  correctOptionIndex: number;
  points: number;
};

type QuizRow = {
  id: string;
  mode: QuizMode;
  status: QuizStatus;
  opensAt: string;
  closesAt: string;
  durationSeconds: number;
  passScore: number | null;
  shuffleQuestions: boolean;
  instructions: string;
  seats: number | null;
  allocatedAt: string | null;
  allocationNote: string | null;
};

type Stats = {
  total: number;
  submitted: number;
  inProgress: number;
  expired: number;
  qualified: number;
};

type LeaderRow = {
  attemptId: string;
  fullName: string;
  email: string;
  status: string;
  percentScore: number | null;
  rank: number | null;
  qualified: boolean | null;
  submittedAt: string | null;
  registrationStatus: string | null;
  queuePosition: number | null;
};

const blankQuestion = (): Question => ({
  prompt: "",
  options: ["", ""],
  correctOptionIndex: 0,
  points: 1,
});

const modeForAdmission = (admissionMode: string): QuizMode | null =>
  admissionMode === "QUIZ_TOP_N"
    ? "TOP_N"
    : admissionMode === "QUIZ_FIRST_QUALIFIED"
      ? "FIRST_QUALIFIED"
      : null;

/**
 * Coordinator quiz workspace: author the paper, open it, watch attempts, then
 * allocate seats. The answer key is visible here because this is the organiser
 * view; the participant API never returns it.
 */
export function QuizPanel({ event, canManage }: { event: EventRow; canManage: boolean }) {
  const mode = modeForAdmission(event.admissionMode);
  const toast = useToast();
  const action = useAction();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Action results are toasts; only a standing condition stays on the page.
  useNotice(error, null);
  const [quiz, setQuiz] = useState<QuizRow | null>(null);
  const [canSeeKey, setCanSeeKey] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [questions, setQuestions] = useState<Question[]>([blankQuestion()]);
  const [form, setForm] = useState({
    opensAt: toLocalInput(new Date(Date.now() + 3_600_000)),
    closesAt: toLocalInput(new Date(Date.now() + 7_200_000)),
    durationSeconds: 600,
    passScore: 60,
    shuffleQuestions: true,
    instructions: "",
    seats: "" as string,
  });
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [confirm, setConfirm] = useState<
    "publish" | "pause" | "resume" | "close" | "allocate" | null
  >(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{
        quiz: QuizRow | null;
        questions: Array<
          Omit<Question, "correctOptionIndex"> & { id: string; correctOptionIndex?: number }
        >;
        stats: Stats | null;
        canSeeAnswerKey?: boolean;
      }>(`/events/${event.id}/quiz`);
      setQuiz(data.quiz);
      setStats(data.stats);
      setCanSeeKey(data.canSeeAnswerKey ?? false);
      if (data.quiz) {
        setQuestions(
          data.questions.map((q) => ({
            prompt: q.prompt,
            options: q.options,
            correctOptionIndex: q.correctOptionIndex ?? 0,
            points: Number(q.points),
          })),
        );
        setForm({
          opensAt: toLocalInput(new Date(data.quiz.opensAt)),
          closesAt: toLocalInput(new Date(data.quiz.closesAt)),
          durationSeconds: data.quiz.durationSeconds,
          passScore: data.quiz.passScore ?? 60,
          shuffleQuestions: data.quiz.shuffleQuestions,
          instructions: data.quiz.instructions ?? "",
          seats: data.quiz.seats === null ? "" : String(data.quiz.seats),
        });
        const leaders = await api<{ items: LeaderRow[] }>(
          `/quizzes/${data.quiz.id}/leaderboard?limit=200`,
        );
        setBoard(leaders.items);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [event.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!mode)
    return (
      <Empty>
        This event uses <strong>{event.admissionMode}</strong> admission. To allocate seats with a
        quiz, set the admission mode to <strong>Quiz · top scores</strong> or{" "}
        <strong>Quiz · first to qualify</strong> in Edit details, then return here.
      </Empty>
    );

  const editable = canManage && (!quiz || quiz.status === "DRAFT") && (stats?.total ?? 0) === 0;

  function updateQuestion(index: number, patch: Partial<Question>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  async function save() {
    setError(null);
    const cleaned = questions.map((q) => ({
      ...q,
      prompt: q.prompt.trim(),
      options: q.options.map((o) => o.trim()).filter(Boolean),
    }));
    if (cleaned.some((q) => q.prompt.length < 3 || q.options.length < 2)) {
      setError("Every question needs a prompt and at least two options.");
      return;
    }
    if (cleaned.some((q) => q.correctOptionIndex >= q.options.length)) {
      setError("Choose the correct option for every question.");
      return;
    }
    await action.run(async () => {
      try {
        await api(
          `/events/${event.id}/quiz`,
          {
            mode,
            opensAt: fromLocalInput(form.opensAt),
            closesAt: fromLocalInput(form.closesAt),
            durationSeconds: Number(form.durationSeconds),
            ...(mode === "FIRST_QUALIFIED" ? { passScore: Number(form.passScore) } : {}),
            shuffleQuestions: form.shuffleQuestions,
            instructions: form.instructions,
            seats: form.seats ? Number(form.seats) : null,
            questions: cleaned,
          },
          { method: "PUT" },
        );
        toast.ok("Quiz saved.");
        await load();
      } catch (err) {
        setError(errorMessage(err));
      }
    });
  }

  async function doConfirm(reason = "") {
    if (!quiz || !confirm) return;
    const target = confirm;
    setConfirm(null);
    await action.run(async () => {
      try {
        if (target === "allocate") {
          const result = await api<{ confirmed: number; waitlisted: number }>(
            `/quizzes/${quiz.id}/allocate`,
            reason ? { note: reason } : {},
            { method: "POST" },
          );
          toast.ok(
            `Seats allocated: ${result.confirmed} confirmed, ${result.waitlisted} waitlisted.`,
          );
        } else {
          const nextStatus =
            target === "publish" || target === "resume"
              ? "PUBLISHED"
              : target === "pause"
                ? "PAUSED"
                : "CLOSED";
          await api(`/quizzes/${quiz.id}/status`, { status: nextStatus }, { method: "PATCH" });
          toast.ok(
            nextStatus === "PUBLISHED"
              ? "Quiz is open for attempts. The clock decides when it closes."
              : nextStatus === "PAUSED"
                ? "Quiz paused. Nobody new can start; attempts already running carry on."
                : "Quiz closed. Any attempt still running was ended.",
          );
        }
        await load();
      } catch (err) {
        setError(errorMessage(err));
      }
    });
  }

  if (loading) return <Loading label="Loading quiz…" />;

  const totalPoints = questions.reduce((a, q) => a + Number(q.points || 0), 0);

  return (
    <div className="stack">
      <Card title="How seats are decided">
        <p className="meta">
          <strong>{QUIZ_MODE_LABELS[mode]}</strong> · {event.capacity} event seats
        </p>
        <p className="meta">{QUIZ_MODE_DESCRIPTIONS[mode]}</p>
        {quiz && (
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <span className="chip">{QUIZ_STATUS_LABELS[quiz.status]}</span>
            <span className="chip">Opens {formatWhen(quiz.opensAt)}</span>
            <span className="chip">Closes {formatWhen(quiz.closesAt)}</span>
            <span className="chip">{Math.round(quiz.durationSeconds / 60)} min per attempt</span>
            {quiz.passScore !== null && <span className="chip">Pass {quiz.passScore}%</span>}
            {quiz.allocatedAt && (
              <span className="badge good">Allocated {formatWhen(quiz.allocatedAt)}</span>
            )}
          </div>
        )}
        {canManage && quiz && (
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            {/*
              The open and close times are authoritative. Inside that window the
              coordinator gets one lever — pause and resume, as often as they
              like — because a network blip at 10:00 should not end an exam.
            */}
            {(quiz.status === "DRAFT" || quiz.status === "CLOSED") && (
              <button type="button" disabled={action.busy} onClick={() => setConfirm("publish")}>
                {quiz.status === "CLOSED" ? "Reopen for attempts" : "Open for attempts"}
              </button>
            )}
            {quiz.status === "PUBLISHED" && (
              <>
                <button type="button" disabled={action.busy} onClick={() => setConfirm("pause")}>
                  Pause quiz
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={action.busy}
                  onClick={() => setConfirm("close")}
                >
                  Close quiz early
                </button>
              </>
            )}
            {quiz.status === "PAUSED" && (
              <button type="button" disabled={action.busy} onClick={() => setConfirm("resume")}>
                Resume quiz
              </button>
            )}
            {mode === "TOP_N" &&
              (quiz.status === "CLOSED" || new Date(quiz.closesAt) < new Date()) &&
              !quiz.allocatedAt && (
                <button type="button" disabled={action.busy} onClick={() => setConfirm("allocate")}>
                  Allocate seats by rank
                </button>
              )}
          </div>
        )}
        {mode === "FIRST_QUALIFIED" && (
          <p className="meta">
            Seats are handed out automatically as each participant reaches the pass mark. There is
            no allocation step to run.
          </p>
        )}
      </Card>

      {stats && stats.total > 0 && (
        <Card title="Attempts so far">
          <div className="stat-grid">
            {(
              [
                ["Started", stats.total],
                ["Submitted", stats.submitted],
                ["In progress", stats.inProgress],
                ["Expired", stats.expired],
              ] as Array<[string, number]>
            ).map(([label, value]) => (
              <div className="stat-card" key={label}>
                <div className="stat-top">
                  <span className="stat-label">{label}</span>
                </div>
                <div className="stat-value">{value}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {editable && (
        <Card title={quiz ? "Edit the paper" : "Create the paper"}>
          <div className="grid-2">
            <Field label="Opens at">
              <input
                type="datetime-local"
                value={form.opensAt}
                onChange={(e) => setForm({ ...form, opensAt: e.target.value })}
              />
            </Field>
            <Field label="Closes at">
              <input
                type="datetime-local"
                value={form.closesAt}
                onChange={(e) => setForm({ ...form, closesAt: e.target.value })}
              />
            </Field>
            <Field label="Minutes per attempt" hint="The clock starts when the participant begins.">
              <input
                type="number"
                min={1}
                max={240}
                value={Math.round(form.durationSeconds / 60)}
                onChange={(e) => setForm({ ...form, durationSeconds: Number(e.target.value) * 60 })}
              />
            </Field>
            {mode === "FIRST_QUALIFIED" && (
              <Field label="Pass score (%)" hint="A participant at or above this is qualified.">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={form.passScore}
                  onChange={(e) => setForm({ ...form, passScore: Number(e.target.value) })}
                />
              </Field>
            )}
            <Field
              label="Seats from this quiz"
              hint={`Blank uses the event capacity (${event.capacity}).`}
            >
              <input
                type="number"
                min={1}
                value={form.seats}
                placeholder={String(event.capacity)}
                onChange={(e) => setForm({ ...form, seats: e.target.value })}
              />
            </Field>
            <Field label="Instructions shown before starting">
              <input
                value={form.instructions}
                maxLength={2000}
                placeholder="No negative marking. One attempt only."
                onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              />
            </Field>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.shuffleQuestions}
              onChange={(e) => setForm({ ...form, shuffleQuestions: e.target.checked })}
            />
            Shuffle question order for each participant
          </label>

          {/* The quiz screen is often the first place people look for "who can
              register". Answer the question with a pointer, once, instead of
              offering a second copy of the rules that can drift from the event's. */}
          <p className="quiz-eligibility-note">
            Who may register for this quiz is the event&apos;s own rule —{" "}
            <strong>{event.admissionMode.startsWith("QUIZ") ? "quiz entry" : "event entry"}</strong>{" "}
            uses the same audience and eligibility settings as everything else. Change them in{" "}
            <strong>Edit details → Who may register</strong>; nothing is configured separately for
            the quiz.
          </p>

          <h4 style={{ marginTop: 16 }}>
            Questions · {questions.length} · {totalPoints} points
          </h4>
          <ol className="question-list">
            {questions.map((q, index) => (
              // Questions have no stable id before saving; the index is the identity here.
              // biome-ignore lint/suspicious/noArrayIndexKey: draft questions are identified by position
              <li className="question-card" key={index}>
                <header className="question-head">
                  <span className="question-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="question-points">
                    {q.points} {Number(q.points) === 1 ? "point" : "points"}
                  </span>
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={questions.length === 1}
                    onClick={() => setQuestions((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </header>

                <label className="question-prompt">
                  <span>Question {index + 1}</span>
                  <textarea
                    rows={2}
                    value={q.prompt}
                    maxLength={1000}
                    placeholder="What should the participant answer?"
                    onChange={(e) => updateQuestion(index, { prompt: e.target.value })}
                  />
                </label>

                <div
                  className="option-list"
                  role="radiogroup"
                  aria-label={`Options for question ${index + 1}`}
                >
                  {q.options.map((opt, oi) => {
                    const correct = q.correctOptionIndex === oi;
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: options are identified by position
                      <div className={correct ? "option-row is-correct" : "option-row"} key={oi}>
                        {/* One control per option that both picks the right answer and
                            says what it is doing. The old radio had no visible link to
                            the field beside it, so "which one is the answer?" was a
                            guess. */}
                        {/* A real radio: the browser gives us arrow-key navigation,
                            one-of-many semantics and form behaviour for free, and the
                            letter is the label so "which option is the answer?" needs
                            no guessing. */}
                        <label className={correct ? "option-mark active" : "option-mark"}>
                          <input
                            type="radio"
                            name={`correct-option-${index}`}
                            checked={correct}
                            onChange={() => updateQuestion(index, { correctOptionIndex: oi })}
                          />
                          <span>{String.fromCharCode(65 + oi)}</span>
                          <span className="sr-only">
                            Mark option {String.fromCharCode(65 + oi)} as the correct answer
                          </span>
                        </label>
                        <input
                          className="option-text"
                          value={opt}
                          maxLength={300}
                          placeholder={`Option ${String.fromCharCode(65 + oi)}`}
                          onChange={(e) =>
                            updateQuestion(index, {
                              options: q.options.map((o, i) => (i === oi ? e.target.value : o)),
                            })
                          }
                        />
                        {correct ? <span className="option-correct-tag">Correct</span> : null}
                        <button
                          type="button"
                          className="ghost tiny"
                          aria-label={`Remove option ${String.fromCharCode(65 + oi)}`}
                          disabled={q.options.length <= 2}
                          onClick={() =>
                            updateQuestion(index, {
                              options: q.options.filter((_, i) => i !== oi),
                              correctOptionIndex:
                                q.correctOptionIndex >= oi && q.correctOptionIndex > 0
                                  ? q.correctOptionIndex - 1
                                  : q.correctOptionIndex,
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>

                <footer className="question-foot">
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={q.options.length >= 6}
                    onClick={() => updateQuestion(index, { options: [...q.options, ""] })}
                  >
                    Add option
                  </button>
                  <label className="question-points-input">
                    <span>Points</span>
                    <input
                      type="number"
                      min={0.25}
                      max={100}
                      step={0.25}
                      value={q.points}
                      onChange={(e) => updateQuestion(index, { points: Number(e.target.value) })}
                    />
                  </label>
                </footer>
              </li>
            ))}
          </ol>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="ghost"
              disabled={questions.length >= 200}
              onClick={() => setQuestions((prev) => [...prev, blankQuestion()])}
            >
              Add question
            </button>
            <button type="button" disabled={action.busy} onClick={save}>
              Save quiz
            </button>
          </div>
        </Card>
      )}

      {!canManage && !quiz && (
        <Empty>
          No quiz has been set up for this event yet. Only its club coordinators can author one.
        </Empty>
      )}

      {!editable && quiz && (
        <Card title="The paper">
          <p className="meta">
            {!canManage
              ? "Read-only. Only this event's coordinators can author or run the quiz."
              : quiz.status !== "DRAFT"
                ? "A published quiz cannot be edited."
                : "Attempts have started, so the paper is locked."}
            {!canSeeKey ? " The answer key is hidden for reviewers." : ""}
          </p>
          <ol className="paper-view">
            {questions.map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: read-only list
              <li key={i}>
                <p className="paper-q">
                  <span className="paper-num">Q{i + 1}</span>
                  {q.prompt}
                  <span className="paper-pts">{q.points}</span>
                </p>
                <ol className="paper-options">
                  {q.options.map((o, oi) => {
                    const correct = canSeeKey && oi === q.correctOptionIndex;
                    return (
                      <li key={`${i}-${oi}-${o}`} className={correct ? "is-answer" : undefined}>
                        <span className="paper-letter">{String.fromCharCode(65 + oi)}</span>
                        {o}
                        {correct ? <span className="paper-answer-tag">Answer</span> : null}
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {quiz && board.length > 0 && (
        <Card title={quiz.allocatedAt ? "Final ranking and seats" : "Live ranking (provisional)"}>
          {!quiz.allocatedAt && mode === "TOP_N" && (
            <p className="meta">
              Ranks update as submissions arrive. Seats are only handed out when you close the quiz
              and allocate.
            </p>
          )}
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Participant</th>
                  <th>Score</th>
                  <th>Attempt</th>
                  <th>Submitted</th>
                  <th>Seat</th>
                </tr>
              </thead>
              <tbody>
                {board.map((r) => (
                  <tr key={r.attemptId}>
                    <td>{r.rank ?? "—"}</td>
                    <td>
                      {r.fullName}
                      <div className="meta">{r.email}</div>
                    </td>
                    <td>{r.percentScore === null ? "—" : `${r.percentScore}%`}</td>
                    <td>{r.status.replace(/_/g, " ").toLowerCase()}</td>
                    <td>{r.submittedAt ? formatWhen(r.submittedAt) : "—"}</td>
                    <td>
                      {r.registrationStatus ? (
                        <span
                          className={`badge ${r.registrationStatus === "CONFIRMED" ? "good" : "info"}`}
                        >
                          {r.registrationStatus.toLowerCase()}
                          {r.queuePosition ? ` #${r.queuePosition}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "publish"
            ? "Open this quiz for attempts?"
            : confirm === "resume"
              ? "Resume this quiz?"
              : confirm === "pause"
                ? "Pause this quiz?"
                : confirm === "close"
                  ? "Close this quiz early?"
                  : "Allocate seats by rank?"
        }
        description={
          confirm === "publish" || confirm === "resume"
            ? "Participants will be able to start their attempt while the window is open. The paper can no longer be edited."
            : confirm === "pause"
              ? "Nobody new can start. Anyone already answering keeps their timer and can still submit — pause stops entry, not the clock. You can resume as many times as you need."
              : confirm === "close"
                ? "This ends the quiz before its close time. Any attempt still running is expired immediately, and nobody can start a new one unless you reopen it inside the window."
                : "The highest scores take the available seats; everyone else is waitlisted in rank order. This runs once and cannot be repeated."
        }
        confirmLabel={confirm === "allocate" ? "Allocate seats" : "Confirm"}
        danger={confirm === "close" || confirm === "allocate"}
        busy={action.busy}
        reasonLabel={confirm === "allocate" ? "Note for the audit trail (optional)" : undefined}
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) => void doConfirm(reason)}
      />
    </div>
  );
}
