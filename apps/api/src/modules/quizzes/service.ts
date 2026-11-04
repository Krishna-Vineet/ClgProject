import {
  type AllocationOutcome,
  type QuizMode,
  allocateTopN,
  attemptSecondsLeft,
  decideFirstQualified,
  isQualified,
  rankAttempts,
  round2,
  scoreAttempt,
} from "@campusops/shared";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  events,
  passes,
  quizAttempts,
  quizQuestions,
  quizzes,
  registrationHistory,
  registrations,
  users,
} from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { isClubCoordinator } from "../../middleware/event-scope";
import { ApiError } from "../../utils/api-error";
import { type AuditContext, insertAudit } from "../audit/service";
import { getVisibleEvent } from "../events/visibility";
import { queueNotification } from "../notifications/outbox";
import type { CreateQuizInput, SubmitAttemptInput } from "./schemas";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["db"]["transaction"]>[0]>[0];

const QUIZ_ADMISSION: Record<string, QuizMode> = {
  QUIZ_TOP_N: "TOP_N",
  QUIZ_FIRST_QUALIFIED: "FIRST_QUALIFIED",
};

function numeric(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === "number" ? value : Number.parseFloat(value);
}

/** The event's admission mode is the single source of truth for the quiz mode. */
/**
 * A quiz may be attached while the event is still a draft, even if it has not
 * been switched to quiz admission yet. The coordinator configures the quiz in
 * the event workspace and then chooses the matching admission mode; refusing
 * the quiz until the mode changes made the two steps impossible to complete.
 */
function assertQuizWritable(event: typeof events.$inferSelect) {
  if (event.status === "CANCELLED" || event.status === "COMPLETED")
    throw new ApiError(
      "INVALID_STATE_TRANSITION",
      "This event is closed; a quiz cannot be configured on it.",
    );
}

async function loadQuiz(quizId: string) {
  const { db } = getDb();
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, quizId)).limit(1);
  if (!quiz) throw new ApiError("NOT_FOUND", "Quiz not found.");
  return quiz;
}

async function loadQuestions(quizId: string) {
  const { db } = getDb();
  return db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(asc(quizQuestions.position));
}

/**
 * Question order is shuffled per attempt when the coordinator asks for it, using
 * a deterministic seed from the attempt id so a reload shows the same paper.
 */
function orderForAttempt<T extends { id: string }>(
  items: T[],
  attemptId: string,
  shuffle: boolean,
) {
  if (!shuffle) return items;
  let seed = 0;
  for (const ch of attemptId) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

// ── Coordinator: configure ──────────────────────────────────────────────────

export async function getForOrganiser(auth: AuthContext, eventId: string) {
  const { db } = getDb();
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.eventId, eventId)).limit(1);
  if (!quiz) return { quiz: null, questions: [], stats: null, canSeeAnswerKey: false };
  const [event] = await db
    .select({ clubId: events.clubId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  // Reviewers (Faculty, HOD/Dean, Admin) can inspect the paper and results but
  // the answer key belongs to the event's coordinators.
  const canSeeAnswerKey = Boolean(event && isClubCoordinator(auth, event.clubId));
  const questions = await loadQuestions(quiz.id);
  const [attemptStats] = await db
    .select({
      total: count(),
      submitted: sql<number>`count(*) filter (where ${quizAttempts.status} = 'SUBMITTED')::int`,
      inProgress: sql<number>`count(*) filter (where ${quizAttempts.status} = 'IN_PROGRESS')::int`,
      expired: sql<number>`count(*) filter (where ${quizAttempts.status} = 'EXPIRED')::int`,
      qualified: sql<number>`count(*) filter (where ${quizAttempts.qualified} = true)::int`,
    })
    .from(quizAttempts)
    .where(eq(quizAttempts.quizId, quiz.id));
  return {
    quiz: { ...quiz, passScore: numeric(quiz.passScore), seats: quiz.seats },
    questions: questions.map((q) => {
      const { correctOptionIndex, ...paper } = q;
      return {
        ...paper,
        ...(canSeeAnswerKey ? { correctOptionIndex } : {}),
        points: numeric(q.points),
      };
    }),
    stats: attemptStats ?? { total: 0, submitted: 0, inProgress: 0, expired: 0, qualified: 0 },
    canSeeAnswerKey,
  };
}

export async function upsertQuiz(
  auth: AuthContext,
  eventId: string,
  input: CreateQuizInput,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  assertQuizWritable(event);
  const requiredMode = QUIZ_ADMISSION[event.admissionMode];
  if (requiredMode && input.mode !== requiredMode)
    throw new ApiError(
      "VALIDATION_ERROR",
      `This event's admission mode is ${event.admissionMode}; the quiz mode must be ${requiredMode}.`,
    );
  const mode = input.mode as QuizMode;

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(quizzes).where(eq(quizzes.eventId, eventId)).limit(1);
    if (existing) {
      if (existing.status !== "DRAFT")
        throw new ApiError(
          "INVALID_STATE_TRANSITION",
          "A published quiz cannot be edited. Close it and create a new event revision instead.",
        );
      const [attempt] = await tx
        .select({ n: count() })
        .from(quizAttempts)
        .where(eq(quizAttempts.quizId, existing.id));
      if ((attempt?.n ?? 0) > 0)
        throw new ApiError(
          "CONFLICT",
          "Someone has already started this quiz; it cannot be edited.",
        );
      await tx.delete(quizQuestions).where(eq(quizQuestions.quizId, existing.id));
      const [updated] = await tx
        .update(quizzes)
        .set({
          mode,
          opensAt: new Date(input.opensAt),
          closesAt: new Date(input.closesAt),
          durationSeconds: input.durationSeconds,
          passScore:
            input.passScore === undefined || input.passScore === null
              ? null
              : String(input.passScore),
          shuffleQuestions: input.shuffleQuestions,
          instructions: input.instructions,
          seats: input.seats ?? null,
        })
        .where(eq(quizzes.id, existing.id))
        .returning();
      if (!updated) throw new ApiError("INTERNAL_ERROR", "Quiz update failed.");
      await tx.insert(quizQuestions).values(
        input.questions.map((q, i) => ({
          quizId: existing.id,
          prompt: q.prompt,
          options: q.options,
          correctOptionIndex: q.correctOptionIndex,
          points: String(q.points),
          position: i + 1,
        })),
      );
      if (audit)
        await insertAudit(tx, audit, {
          action: "QUIZ_UPDATED",
          entityType: "quiz",
          entityId: existing.id,
          eventId,
          clubId: event.clubId,
          after: { mode, questions: input.questions.length },
        });
      return { ...updated, passScore: numeric(updated.passScore) };
    }

    const [created] = await tx
      .insert(quizzes)
      .values({
        eventId,
        mode,
        opensAt: new Date(input.opensAt),
        closesAt: new Date(input.closesAt),
        durationSeconds: input.durationSeconds,
        passScore:
          input.passScore === undefined || input.passScore === null
            ? null
            : String(input.passScore),
        shuffleQuestions: input.shuffleQuestions,
        instructions: input.instructions,
        seats: input.seats ?? null,
        createdBy: auth.user.id,
      })
      .returning();
    if (!created) throw new ApiError("INTERNAL_ERROR", "Quiz creation failed.");
    await tx.insert(quizQuestions).values(
      input.questions.map((q, i) => ({
        quizId: created.id,
        prompt: q.prompt,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        points: String(q.points),
        position: i + 1,
      })),
    );
    if (audit)
      await insertAudit(tx, audit, {
        action: "QUIZ_CREATED",
        entityType: "quiz",
        entityId: created.id,
        eventId,
        clubId: event.clubId,
        after: { mode, questions: input.questions.length },
      });
    return { ...created, passScore: numeric(created.passScore) };
  });
}

export async function setStatus(
  quizId: string,
  status: "PUBLISHED" | "CLOSED",
  audit?: AuditContext,
) {
  const quiz = await loadQuiz(quizId);
  if (status === "PUBLISHED") {
    if (quiz.status !== "DRAFT")
      throw new ApiError("INVALID_STATE_TRANSITION", "Only a draft quiz can be published.");
    const questions = await loadQuestions(quizId);
    if (questions.length === 0)
      throw new ApiError("VALIDATION_ERROR", "Add at least one question before publishing.");
    const { db } = getDb();
    const [event] = await db.select().from(events).where(eq(events.id, quiz.eventId)).limit(1);
    if (!event || !["READY", "PUBLISHED", "LIVE"].includes(event.status))
      throw new ApiError("INVALID_STATE_TRANSITION", "Publish the event before opening its quiz.");
  }
  if (status === "CLOSED" && quiz.status === "CLOSED") return quiz;
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(quizzes)
      .set({ status })
      .where(eq(quizzes.id, quizId))
      .returning();
    // Closing ends any attempt still running so nobody gains extra time.
    if (status === "CLOSED") {
      await tx
        .update(quizAttempts)
        .set({ status: "EXPIRED" })
        .where(and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.status, "IN_PROGRESS")));
    }
    if (audit)
      await insertAudit(tx, audit, {
        action: status === "PUBLISHED" ? "QUIZ_PUBLISHED" : "QUIZ_CLOSED",
        entityType: "quiz",
        entityId: quizId,
        eventId: quiz.eventId,
        after: { status },
      });
    return updated;
  });
}

// ── Participant: attempt ────────────────────────────────────────────────────

/** What the phone shows before starting: rules and state, never the answer key. */
export async function participantView(auth: AuthContext, eventId: string) {
  await getVisibleEvent(auth, eventId);
  const { db } = getDb();
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.eventId, eventId)).limit(1);
  if (!quiz || quiz.status === "DRAFT") return { quiz: null, attempt: null };
  const [questionCount] = await db
    .select({ n: count(), points: sql<string>`coalesce(sum(${quizQuestions.points}), 0)` })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id));
  const [attempt] = await db
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, auth.user.id)))
    .limit(1);
  const [registration] = await db
    .select()
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, auth.user.id)))
    .limit(1);
  const now = new Date();
  return {
    quiz: {
      id: quiz.id,
      mode: quiz.mode,
      status: quiz.status,
      opensAt: quiz.opensAt,
      closesAt: quiz.closesAt,
      durationSeconds: quiz.durationSeconds,
      passScore: numeric(quiz.passScore),
      instructions: quiz.instructions,
      questionCount: questionCount?.n ?? 0,
      maxScore: round2(Number.parseFloat(questionCount?.points ?? "0")),
      allocatedAt: quiz.allocatedAt,
    },
    attempt: attempt
      ? {
          id: attempt.id,
          status: attempt.status,
          startedAt: attempt.startedAt,
          expiresAt: attempt.expiresAt,
          submittedAt: attempt.submittedAt,
          secondsLeft: attemptSecondsLeft(attempt.expiresAt, now),
          score: numeric(attempt.score),
          percentScore: numeric(attempt.percentScore),
          qualified: attempt.qualified,
          rank: attempt.rank,
          allocatedStatus: attempt.allocatedStatus,
        }
      : null,
    registration: registration
      ? {
          id: registration.id,
          status: registration.status,
          queuePosition: registration.queuePosition,
        }
      : null,
    windowOpen: quiz.status === "PUBLISHED" && now >= quiz.opensAt && now <= quiz.closesAt,
  };
}

/**
 * Start (or resume) the one permitted attempt. The clock starts on the server and
 * is capped by the quiz close time, so starting late never extends the window.
 */
export async function startAttempt(auth: AuthContext, eventId: string, audit?: AuditContext) {
  await getVisibleEvent(auth, eventId);
  if (auth.user.accountType === "STAFF")
    throw new ApiError("FORBIDDEN", "Staff accounts do not take part in participant quizzes.");
  const { db } = getDb();
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.eventId, eventId)).limit(1);
  if (!quiz) throw new ApiError("EVENT_NOT_OPEN", "This quiz is not open for attempts.");
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
  if (QUIZ_ADMISSION[event.admissionMode] !== quiz.mode)
    throw new ApiError(
      "VALIDATION_ERROR",
      "This quiz is not part of the event's admission process.",
    );
  if (quiz.status !== "PUBLISHED")
    throw new ApiError("EVENT_NOT_OPEN", "This quiz is not open for attempts.");

  const now = new Date();
  if (now < quiz.opensAt || now > quiz.closesAt)
    throw new ApiError("EVENT_NOT_OPEN", "The quiz window is not open right now.");

  const questions = await loadQuestions(quiz.id);
  if (questions.length === 0)
    throw new ApiError("INVALID_STATE_TRANSITION", "This quiz has no questions.");

  const attempt = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(quizAttempts)
      .where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, auth.user.id)))
      .limit(1);
    if (existing) {
      if (existing.status === "SUBMITTED")
        throw new ApiError("CONFLICT", "You have already submitted this quiz.");
      if (existing.status === "EXPIRED" || existing.expiresAt <= now) {
        if (existing.status === "IN_PROGRESS")
          await tx
            .update(quizAttempts)
            .set({ status: "EXPIRED" })
            .where(eq(quizAttempts.id, existing.id));
        throw new ApiError(
          "EVENT_NOT_OPEN",
          "Your attempt has expired. Only one attempt is allowed.",
        );
      }
      return existing;
    }
    const expiresAt = new Date(
      Math.min(now.getTime() + quiz.durationSeconds * 1000, quiz.closesAt.getTime()),
    );
    const [created] = await tx
      .insert(quizAttempts)
      .values({ quizId: quiz.id, userId: auth.user.id, expiresAt })
      .returning();
    if (!created) throw new ApiError("INTERNAL_ERROR", "Could not start the attempt.");
    if (audit)
      await insertAudit(tx, audit, {
        action: "QUIZ_ATTEMPT_STARTED",
        entityType: "quiz_attempt",
        entityId: created.id,
        eventId,
        after: { quizId: quiz.id, expiresAt: expiresAt.toISOString() },
      });
    return created;
  });

  // The answer key never leaves the server before submission.
  const paper = orderForAttempt(questions, attempt.id, quiz.shuffleQuestions).map((q) => ({
    id: q.id,
    prompt: q.prompt,
    options: q.options as string[],
    points: numeric(q.points),
  }));
  return {
    attemptId: attempt.id,
    status: attempt.status,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    secondsLeft: attemptSecondsLeft(attempt.expiresAt, new Date()),
    answers: (attempt.answers ?? {}) as Record<string, number>,
    questions: paper,
  };
}

/**
 * Submit and score. FIRST_QUALIFIED allocates the seat inside this transaction
 * under the event row lock; TOP_N only records the score and waits for the
 * coordinator's allocation run.
 */
export async function submitAttempt(
  auth: AuthContext,
  eventId: string,
  input: SubmitAttemptInput,
  audit?: AuditContext,
) {
  const { db } = getDb();
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.eventId, eventId)).limit(1);
  if (!quiz) throw new ApiError("NOT_FOUND", "Quiz not found.");
  const questions = await loadQuestions(quiz.id);
  const result = scoreAttempt(
    questions.map((q) => ({
      id: q.id,
      correctOptionIndex: q.correctOptionIndex,
      points: q.points,
    })),
    input.answers,
  );
  const passScore = numeric(quiz.passScore);

  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(quizAttempts)
      .where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, auth.user.id)))
      .for("update")
      .limit(1);
    if (!attempt) throw new ApiError("NOT_FOUND", "Start the quiz before submitting.");
    if (attempt.status === "SUBMITTED") {
      // Idempotent replay: return the recorded result, never re-allocate a seat.
      return {
        alreadySubmitted: true,
        score: numeric(attempt.score),
        maxScore: result.maxScore,
        percentScore: numeric(attempt.percentScore),
        qualified: attempt.qualified,
        outcome: attempt.allocatedStatus,
        rank: attempt.rank,
        correctCount: result.correctCount,
        totalQuestions: result.totalQuestions,
      };
    }
    const now = new Date();
    // A submission after the deadline is recorded as expired and scores nothing.
    const late = attempt.expiresAt < now || quiz.status !== "PUBLISHED" || now > quiz.closesAt;
    if (late) {
      await tx
        .update(quizAttempts)
        .set({
          status: "EXPIRED",
          answers: input.answers,
          score: "0",
          percentScore: "0",
          qualified: false,
          submittedAt: now,
        })
        .where(eq(quizAttempts.id, attempt.id));
      throw new ApiError("EVENT_NOT_OPEN", "Time is up. This attempt was closed without a score.");
    }

    const qualified = isQualified(quiz.mode, result.percent, passScore);
    let outcome: AllocationOutcome | null = null;
    let registrationId: string | null = null;

    if (quiz.mode === "FIRST_QUALIFIED") {
      // Lock the event so two simultaneous submissions cannot take one seat.
      const [event] = await tx
        .select()
        .from(events)
        .where(eq(events.id, eventId))
        .for("update")
        .limit(1);
      if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
      const seats = quiz.seats ?? event.capacity;
      const [taken] = await tx
        .select({ n: count() })
        .from(registrations)
        .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "CONFIRMED")));
      const decision = decideFirstQualified({
        percent: result.percent,
        passScore,
        seats,
        seatsTaken: taken?.n ?? 0,
      });
      outcome = decision.outcome;
      registrationId = await applyOutcome(tx, {
        eventId,
        userId: auth.user.id,
        event,
        outcome,
        reason: qualified
          ? `Qualified with ${result.percent}% (first-to-qualify).`
          : `Scored ${result.percent}%, below the ${passScore}% pass mark.`,
        actorId: auth.user.id,
        quizId: quiz.id,
      });
    }

    await tx
      .update(quizAttempts)
      .set({
        status: "SUBMITTED",
        answers: input.answers,
        score: String(result.score),
        percentScore: String(result.percent),
        qualified,
        allocatedStatus: outcome,
        submittedAt: now,
        clientSubmittedAt: input.clientSubmittedAt ? new Date(input.clientSubmittedAt) : null,
      })
      .where(eq(quizAttempts.id, attempt.id));

    if (audit)
      await insertAudit(tx, audit, {
        action: "QUIZ_ATTEMPT_SUBMITTED",
        entityType: "quiz_attempt",
        entityId: attempt.id,
        eventId,
        after: { percent: result.percent, qualified, outcome, registrationId },
      });

    return {
      alreadySubmitted: false,
      score: result.score,
      maxScore: result.maxScore,
      percentScore: result.percent,
      qualified,
      outcome,
      rank: null,
      correctCount: result.correctCount,
      totalQuestions: result.totalQuestions,
    };
  });
}

/**
 * Write the registration a quiz outcome implies, issuing or revoking the pass in
 * the same transaction so a seat and its QR can never disagree.
 */
async function applyOutcome(
  tx: Tx,
  input: {
    eventId: string;
    userId: string;
    event: typeof events.$inferSelect;
    outcome: AllocationOutcome;
    reason: string;
    actorId: string;
    quizId: string;
  },
): Promise<string> {
  const { eventId, userId, event, outcome, reason, actorId } = input;
  const [existing] = await tx
    .select()
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)))
    .limit(1);

  let queuePosition: number | null = null;
  if (outcome === "WAITLISTED") {
    const [tail] = await tx
      .select({ n: sql<number>`coalesce(max(${registrations.queuePosition}), 0)::int` })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "WAITLISTED")));
    queuePosition = (tail?.n ?? 0) + 1;
  }

  let registrationId: string;
  if (existing) {
    if (existing.status === "CANCELLED")
      throw new ApiError("CONFLICT", "This registration was withdrawn. Contact the coordinator.");
    await tx
      .update(registrations)
      .set({
        status: outcome,
        queuePosition,
        confirmedAt: outcome === "CONFIRMED" ? new Date() : null,
        rejectionReason: outcome === "REJECTED" ? reason : null,
        updatedAt: new Date(),
      })
      .where(eq(registrations.id, existing.id));
    registrationId = existing.id;
    await tx.insert(registrationHistory).values({
      registrationId,
      fromStatus: existing.status,
      toStatus: outcome,
      actorId,
      reason,
    });
  } else {
    const [created] = await tx
      .insert(registrations)
      .values({
        eventId,
        userId,
        status: outcome,
        admissionModeSnapshot: event.admissionMode,
        eligibilitySnapshot: { source: "QUIZ", quizId: input.quizId, reason },
        eventRevision: event.currentRevision,
        queuePosition,
        ...(outcome === "CONFIRMED" ? { confirmedAt: new Date() } : {}),
        ...(outcome === "REJECTED" ? { rejectionReason: reason } : {}),
      })
      .returning();
    if (!created) throw new ApiError("INTERNAL_ERROR", "Could not record the quiz result.");
    registrationId = created.id;
    await tx.insert(registrationHistory).values({
      registrationId,
      fromStatus: null,
      toStatus: outcome,
      actorId,
      reason,
    });
  }

  if (outcome === "CONFIRMED") {
    await tx
      .insert(passes)
      .values({ registrationId })
      .onConflictDoNothing({ target: passes.registrationId });
    await tx
      .update(passes)
      .set({ revokedAt: null })
      .where(eq(passes.registrationId, registrationId));
  } else {
    await tx
      .update(passes)
      .set({ revokedAt: new Date() })
      .where(eq(passes.registrationId, registrationId));
  }
  return registrationId;
}

/**
 * TOP_N allocation. Runs once, after the quiz is closed, and is deliberately
 * explicit: the coordinator sees the ranking before seats are handed out.
 */
export async function allocate(quizId: string, note: string | undefined, audit?: AuditContext) {
  const quiz = await loadQuiz(quizId);
  if (quiz.mode !== "TOP_N")
    throw new ApiError(
      "VALIDATION_ERROR",
      "First-to-qualify allocates each seat on submission; there is nothing to run.",
    );
  if (quiz.status !== "CLOSED")
    throw new ApiError("INVALID_STATE_TRANSITION", "Close the quiz before allocating seats.");
  if (quiz.allocatedAt)
    throw new ApiError("CONFLICT", "Seats have already been allocated for this quiz.");

  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, quiz.eventId))
      .for("update")
      .limit(1);
    if (!event) throw new ApiError("NOT_FOUND", "Event not found.");
    if (QUIZ_ADMISSION[event.admissionMode] !== quiz.mode)
      throw new ApiError(
        "VALIDATION_ERROR",
        "This quiz is not part of the event's admission process.",
      );
    const rows = await tx
      .select()
      .from(quizAttempts)
      .where(and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.status, "SUBMITTED")));
    if (rows.length === 0)
      throw new ApiError(
        "VALIDATION_ERROR",
        "Nobody submitted this quiz; there is nothing to allocate.",
      );

    const seats = quiz.seats ?? event.capacity;
    const allocation = allocateTopN(
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        percent: numeric(r.percentScore) ?? 0,
        submittedAt: r.submittedAt ?? r.startedAt,
      })),
      seats,
    );

    // Anyone already holding a confirmed seat outside the quiz (e.g. an invited
    // participant added by an organiser) keeps it and consumes a seat.
    const userIds = allocation.map((a) => a.userId);
    const [preConfirmed] = await tx
      .select({ n: count() })
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, quiz.eventId),
          eq(registrations.status, "CONFIRMED"),
          userIds.length ? sql`${registrations.userId} not in ${userIds}` : sql`true`,
        ),
      );
    const external = preConfirmed?.n ?? 0;
    const effective =
      external > 0
        ? allocateTopN(
            rows.map((r) => ({
              id: r.id,
              userId: r.userId,
              percent: numeric(r.percentScore) ?? 0,
              submittedAt: r.submittedAt ?? r.startedAt,
            })),
            Math.max(0, seats - external),
          )
        : allocation;

    let confirmed = 0;
    let waitlisted = 0;
    for (const row of effective) {
      await applyOutcome(tx, {
        eventId: quiz.eventId,
        userId: row.userId,
        event,
        outcome: row.outcome,
        reason: `Quiz rank ${row.rank} at ${row.percent}% (top ${seats} seats).`,
        actorId: audit?.actorId ?? event.createdBy,
        quizId,
      });
      await tx
        .update(quizAttempts)
        .set({ rank: row.rank, qualified: true, allocatedStatus: row.outcome })
        .where(eq(quizAttempts.id, row.id));
      if (row.outcome === "CONFIRMED") confirmed += 1;
      else waitlisted += 1;
    }

    const [updated] = await tx
      .update(quizzes)
      .set({ allocatedAt: new Date(), allocationNote: note ?? null })
      .where(eq(quizzes.id, quizId))
      .returning();
    if (audit)
      await insertAudit(tx, audit, {
        action: "QUIZ_SEATS_ALLOCATED",
        entityType: "quiz",
        entityId: quizId,
        eventId: quiz.eventId,
        clubId: event.clubId,
        after: { seats, confirmed, waitlisted, external, note: note ?? null },
      });
    await queueNotification(tx, {
      kind: "QUIZ_ALLOCATED",
      eventId: quiz.eventId,
      fallbackTier: "FACULTY",
      subject: `Seats allocated: ${event.title}`,
      body: `${confirmed} participant(s) confirmed and ${waitlisted} waitlisted for ${event.title} by quiz rank.`,
      payload: { quizId, confirmed, waitlisted },
    });
    return { quiz: updated, seats, confirmed, waitlisted, considered: effective.length };
  });
}

/** Organiser leaderboard: every attempt with its rank and resulting seat. */
export async function leaderboard(quizId: string, limit: number, offset: number) {
  const quiz = await loadQuiz(quizId);
  const { db } = getDb();
  const rows = await db
    .select({
      attempt: quizAttempts,
      fullName: users.fullName,
      email: users.email,
      registrationStatus: registrations.status,
      queuePosition: registrations.queuePosition,
    })
    .from(quizAttempts)
    .innerJoin(users, eq(users.id, quizAttempts.userId))
    .leftJoin(
      registrations,
      and(eq(registrations.eventId, quiz.eventId), eq(registrations.userId, quizAttempts.userId)),
    )
    .where(eq(quizAttempts.quizId, quizId));

  const submitted = rows.filter((r) => r.attempt.status === "SUBMITTED");
  const ranked = rankAttempts(
    submitted.map((r) => ({
      id: r.attempt.id,
      userId: r.attempt.userId,
      percent: numeric(r.attempt.percentScore) ?? 0,
      submittedAt: r.attempt.submittedAt ?? r.attempt.startedAt,
    })),
  );
  const rankBy = new Map(ranked.map((r) => [r.id, r.rank]));
  const ordered = rows
    .map((r) => ({
      attemptId: r.attempt.id,
      userId: r.attempt.userId,
      fullName: r.fullName,
      email: r.email,
      status: r.attempt.status,
      percentScore: numeric(r.attempt.percentScore),
      score: numeric(r.attempt.score),
      qualified: r.attempt.qualified,
      // Before allocation the provisional rank still explains the ordering.
      rank: r.attempt.rank ?? rankBy.get(r.attempt.id) ?? null,
      submittedAt: r.attempt.submittedAt,
      registrationStatus: r.registrationStatus,
      queuePosition: r.queuePosition,
    }))
    .sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
      if (a.rank !== null) return -1;
      if (b.rank !== null) return 1;
      return a.fullName.localeCompare(b.fullName);
    });
  return {
    items: ordered.slice(offset, offset + limit),
    total: ordered.length,
    limit,
    offset,
    hasMore: offset + limit < ordered.length,
  };
}

/** Quiz ids for a set of events, used by the participant event feed. */
export async function quizBadges(eventIds: string[]) {
  if (eventIds.length === 0) return new Map<string, { mode: QuizMode; status: string }>();
  const { db } = getDb();
  const rows = await db
    .select({ eventId: quizzes.eventId, mode: quizzes.mode, status: quizzes.status })
    .from(quizzes)
    .where(and(inArray(quizzes.eventId, eventIds), sql`${quizzes.status} <> 'DRAFT'`));
  return new Map(rows.map((r) => [r.eventId, { mode: r.mode, status: r.status }]));
}

export { loadQuiz, numeric as quizNumeric };
