import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  Empty,
  Loading,
  Muted,
  Note,
  Row,
  Screen,
  ScreenOverlay,
  Title,
  colors,
} from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { when } from "../lib/format";
import type { Paper, ParticipantQuiz, QuizResult } from "../lib/quizTypes";
import { useSession } from "../lib/session";

const clock = (seconds: number) => {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

/**
 * Participant quiz. The countdown is driven by the server's remaining seconds,
 * not the phone clock, and auto-submits at zero so an expired attempt cannot be
 * used to keep answering. The correct answers are never sent to this screen.
 */
export function QuizScreen({
  eventId,
  eventTitle,
  onClose,
}: {
  eventId: string;
  eventTitle: string;
  onClose: () => void;
}) {
  const { config } = useSession();
  const timeZone = config?.campusTimezone ?? "Asia/Kolkata";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ParticipantQuiz | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuizResult | null>(null);
  const submitted = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setView(await api<ParticipantQuiz>(`/events/${eventId}/quiz/me`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (auto = false) => {
      if (submitted.current) return;
      submitted.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await api<QuizResult>(`/events/${eventId}/quiz/attempts/submit`, {
          answers,
          clientSubmittedAt: new Date().toISOString(),
        });
        setResult(res);
        setPaper(null);
        if (auto) setError("Time is up, so your answers were submitted automatically.");
        await load();
      } catch (e) {
        submitted.current = false;
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [answers, eventId, load],
  );

  // Countdown from the server's figure; re-anchored whenever the paper loads.
  useEffect(() => {
    if (!paper) return;
    const timer = setInterval(() => {
      setLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          void submit(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [paper, submit]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<Paper>(`/events/${eventId}/quiz/attempts`, {});
      setPaper(res);
      setAnswers(res.answers ?? {});
      setLeft(res.secondsLeft);
      submitted.current = false;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading label="Loading quiz…" />;

  const quiz = view?.quiz ?? null;
  const attempt = view?.attempt ?? null;
  const answered = Object.keys(answers).length;

  return (
    <>
      <ScreenOverlay visible={busy} label="Checking your answers" />
      <Screen>
        <Title eyebrow="Seat allocation" title="Quiz" subtitle={eventTitle} />
        <Button label="Back to event" variant="ghost" onPress={onClose} />
        <Note message={error} tone={error?.startsWith("Time is up") ? "warn" : "bad"} />

        {!quiz && (
          <Empty
            doodle="book"
            title="No quiz open"
            detail="The coordinator has not opened a quiz for this event yet."
          />
        )}

        {/* ── Taking the paper ───────────────────────────────────────────── */}
        {paper && (
          <>
            <Card title="Time remaining">
              <Text
                accessibilityLiveRegion="polite"
                style={{
                  fontSize: 30,
                  fontWeight: "700",
                  color: left <= 60 ? colors.bad : colors.ink,
                }}
              >
                {clock(left)}
              </Text>
              <Muted>
                {answered} of {paper.questions.length} answered. Your answers are sent when you
                submit or when the timer ends.
              </Muted>
            </Card>

            {paper.questions.map((q, index) => (
              <Card key={q.id} title={`Question ${index + 1} of ${paper.questions.length}`}>
                <Text style={{ color: colors.ink, lineHeight: 22, marginBottom: 10 }}>
                  {q.prompt}
                </Text>
                <View style={{ gap: 8 }}>
                  {q.options.map((option, oi) => {
                    const selected = answers[q.id] === oi;
                    return (
                      <Button
                        key={`${q.id}-${option}`}
                        label={`${String.fromCharCode(65 + oi)}. ${option}`}
                        variant={selected ? "primary" : "ghost"}
                        onPress={() => setAnswers((prev) => ({ ...prev, [q.id]: oi }))}
                        testID={`option-${index}-${oi}`}
                      />
                    );
                  })}
                </View>
                <Muted>
                  {q.points} point{q.points === 1 ? "" : "s"}
                </Muted>
              </Card>
            ))}

            <Button
              label={`Submit answers (${answered}/${paper.questions.length})`}
              busy={busy}
              onPress={() => void submit()}
              testID="submit-quiz"
            />
            <Muted>You get one attempt. Submitting cannot be undone.</Muted>
          </>
        )}

        {/* A pause mid-attempt is not an interruption: the student carries on, but
            they should know why nobody new is joining and that they are not stuck. */}
        {paper && view?.phase === "PAUSED" && (
          <Note
            message="Coordinators have paused this quiz for new starters. Your attempt is still running — finish and submit before your timer ends."
            tone="warn"
          />
        )}

        {/* ── Result ─────────────────────────────────────────────────────── */}
        {!paper && result && (
          <Card title={result.expired ? "Time ran out" : "Your result"}>
            {result.expired ? (
              <Note
                message="Your attempt expired before it was submitted, so it scored nothing."
                tone="warn"
              />
            ) : (
              <>
                <Row label="Score" value={`${result.score ?? 0} / ${result.maxScore}`} />
                <Row label="Percentage" value={`${result.percentScore ?? 0}%`} />
                {result.correctCount !== undefined && (
                  <Row
                    label="Correct"
                    value={`${result.correctCount} of ${result.totalQuestions ?? 0}`}
                  />
                )}
                {result.qualified !== null && (
                  <View style={{ marginTop: 8 }}>
                    <Badge
                      label={result.qualified ? "Qualified" : "Below the pass mark"}
                      tone={result.qualified ? "good" : "bad"}
                    />
                  </View>
                )}
                {result.outcome && (
                  <View style={{ marginTop: 8 }}>
                    <Badge
                      label={
                        result.outcome === "CONFIRMED"
                          ? "Seat confirmed"
                          : result.outcome === "WAITLISTED"
                            ? "On the waitlist"
                            : "No seat"
                      }
                      tone={result.outcome === "CONFIRMED" ? "good" : "warn"}
                    />
                  </View>
                )}
              </>
            )}
          </Card>
        )}

        {/* ── Before starting / after finishing ──────────────────────────── */}
        {!paper && quiz && (
          <Card title="How this quiz works">
            <Row
              label="Seat rule"
              value={
                quiz.mode === "TOP_N"
                  ? "Highest scores get the seats"
                  : "First to reach the pass mark, until full"
              }
            />
            <Row label="Questions" value={String(quiz.questionCount)} />
            <Row
              label="Time per attempt"
              value={`${Math.round(quiz.durationSeconds / 60)} minutes`}
            />
            {quiz.passScore !== null && <Row label="Pass mark" value={`${quiz.passScore}%`} />}
            <Row label="Opens" value={when(quiz.opensAt, timeZone)} />
            <Row label="Closes" value={when(quiz.closesAt, timeZone)} />
            <Muted>
              {quiz.mode === "TOP_N"
                ? "Everyone's scores are ranked when the quiz closes. Ties are broken by who submitted first."
                : "As soon as you reach the pass mark you take the next free seat. If the seats are gone you join the waitlist."}
            </Muted>
            {quiz.instructions ? (
              <View style={{ marginTop: 8 }}>
                <Muted>From the coordinator</Muted>
                <Text style={{ color: colors.ink, lineHeight: 20 }}>{quiz.instructions}</Text>
              </View>
            ) : null}
          </Card>
        )}

        {!paper && quiz && !attempt && (
          <>
            {/*
              Three different situations used to share one message. A paused quiz is
              not a closed one: the student can still get in, so tell them who to
              ask and that their chance has not gone.
            */}
            {view?.phase === "PAUSED" ? (
              <Note
                message="The coordinators have paused this quiz. You cannot start right now — contact your club faculty or lead, and try again once it resumes."
                tone="warn"
              />
            ) : view?.windowOpen ? (
              <Button label="Start my attempt" busy={busy} onPress={start} testID="start-quiz" />
            ) : (
              <Note
                message={
                  view?.phase === "WINDOW_CLOSED" || quiz.status === "CLOSED"
                    ? "This quiz has closed. You did not start an attempt in time."
                    : `The quiz opens ${when(quiz.opensAt, timeZone)}.`
                }
                tone="neutral"
              />
            )}
            <Muted>Once you start, the timer runs even if you close the app.</Muted>
          </>
        )}

        {!paper && attempt && (
          <Card
            title={attempt.status === "IN_PROGRESS" ? "Attempt in progress" : "Attempt finished"}
          >
            <Row label="Status" value={attempt.status.replace(/_/g, " ").toLowerCase()} />
            {attempt.status === "IN_PROGRESS" && (
              <>
                <Row label="Time left" value={clock(attempt.secondsLeft)} />
                <Button label="Resume attempt" busy={busy} onPress={start} testID="resume-quiz" />
                <Muted>The clock kept running while you were away.</Muted>
              </>
            )}
            {attempt.status !== "IN_PROGRESS" && (
              <>
                {attempt.percentScore !== null && (
                  <Row label="Your score" value={`${attempt.percentScore}%`} />
                )}
                {attempt.rank !== null && <Row label="Rank" value={`#${attempt.rank}`} />}
                {view?.registration && (
                  <Row
                    label="Place"
                    value={
                      view.registration.status === "WAITLISTED" && view.registration.queuePosition
                        ? `Waitlisted #${view.registration.queuePosition}`
                        : view.registration.status.toLowerCase()
                    }
                  />
                )}
                {quiz?.allocatedAt === null && quiz?.mode === "TOP_N" && (
                  <Muted>
                    Seats are handed out after the quiz closes. Your rank may still move as others
                    submit.
                  </Muted>
                )}
              </>
            )}
          </Card>
        )}
      </Screen>
    </>
  );
}
