/**
 * Quiz scoring and seat allocation. Pure functions so the exact rules that
 * decide who gets a seat are unit-testable without a database, and so the
 * website, the API and the phone all describe them identically.
 *
 * Two allocation modes, both required by the brief:
 *
 *  TOP_N            everyone attempts inside the window; when the coordinator
 *                   closes and allocates, the highest scores take the seats.
 *                   Ties break on earlier submission, then on the attempt id so
 *                   the order is total and reproducible.
 *
 *  FIRST_QUALIFIED  a participant who reaches the pass score is confirmed
 *                   immediately, in submission order, until the seats run out.
 *                   Later qualifiers waitlist even with a perfect score.
 */

import type { QuizMode } from "../constants/operations";

export type ScorableQuestion = {
  id: string;
  correctOptionIndex: number;
  /** Numeric columns arrive as strings from Postgres; accept both. */
  points: number | string;
};

export type ScoreResult = {
  score: number;
  maxScore: number;
  percent: number;
  correctCount: number;
  answeredCount: number;
  totalQuestions: number;
};

const toNumber = (v: number | string) => (typeof v === "number" ? v : Number.parseFloat(v));

/** Round to 2 decimals the same way everywhere (Postgres numeric(5,2)). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Unanswered questions score zero; there is no negative marking. An answer for a
 * question that is not in the quiz is ignored rather than trusted.
 */
export function scoreAttempt(
  questions: ScorableQuestion[],
  answers: Record<string, number>,
): ScoreResult {
  let score = 0;
  let maxScore = 0;
  let correctCount = 0;
  let answeredCount = 0;
  for (const q of questions) {
    const points = toNumber(q.points);
    maxScore += points;
    const given = answers[q.id];
    if (typeof given !== "number" || !Number.isInteger(given) || given < 0) continue;
    answeredCount += 1;
    if (given === q.correctOptionIndex) {
      score += points;
      correctCount += 1;
    }
  }
  return {
    score: round2(score),
    maxScore: round2(maxScore),
    percent: maxScore > 0 ? round2((score / maxScore) * 100) : 0,
    correctCount,
    answeredCount,
    totalQuestions: questions.length,
  };
}

/** FIRST_QUALIFIED compares against the cutoff; TOP_N has no pass mark. */
export function isQualified(mode: QuizMode, percent: number, passScore: number | null): boolean {
  if (mode !== "FIRST_QUALIFIED") return true;
  if (passScore === null) return false;
  return percent >= passScore;
}

export type RankableAttempt = {
  id: string;
  userId: string;
  percent: number;
  /** Earlier submission wins a tie. */
  submittedAt: Date | string;
};

export type RankedAttempt = RankableAttempt & { rank: number };

const millis = (v: Date | string) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/**
 * Total, deterministic order: percent desc, submittedAt asc, id asc. The id
 * tiebreak matters — without it two attempts submitted in the same millisecond
 * could swap places between runs and change who gets the last seat.
 */
export function rankAttempts<T extends RankableAttempt>(
  attempts: T[],
): Array<T & { rank: number }> {
  return [...attempts]
    .sort((a, b) => {
      if (b.percent !== a.percent) return b.percent - a.percent;
      const time = millis(a.submittedAt) - millis(b.submittedAt);
      if (time !== 0) return time;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((a, i) => ({ ...a, rank: i + 1 }));
}

export type AllocationOutcome = "CONFIRMED" | "WAITLISTED" | "REJECTED";

export type AllocationRow = RankedAttempt & {
  qualified: boolean;
  outcome: AllocationOutcome;
};

/**
 * TOP_N batch allocation. Only qualified attempts compete; the first `seats`
 * are confirmed, the rest waitlist in rank order so a withdrawal promotes the
 * next-best scorer rather than an arbitrary queue.
 */
export function allocateTopN(attempts: RankableAttempt[], seats: number): AllocationRow[] {
  const ranked = rankAttempts(attempts);
  return ranked.map((a) => ({
    ...a,
    qualified: true,
    outcome: a.rank <= Math.max(0, seats) ? "CONFIRMED" : "WAITLISTED",
  }));
}

/**
 * FIRST_QUALIFIED decision for one attempt at submit time. `seatsTaken` is the
 * confirmed count read under the event row lock, so two phones submitting in the
 * same instant cannot both take the last seat.
 */
export function decideFirstQualified(input: {
  percent: number;
  passScore: number | null;
  seats: number;
  seatsTaken: number;
}): { qualified: boolean; outcome: AllocationOutcome } {
  const qualified = isQualified("FIRST_QUALIFIED", input.percent, input.passScore);
  if (!qualified) return { qualified, outcome: "REJECTED" };
  return {
    qualified,
    outcome: input.seatsTaken < Math.max(0, input.seats) ? "CONFIRMED" : "WAITLISTED",
  };
}

export const QUIZ_MODE_LABELS: Record<QuizMode, string> = {
  TOP_N: "Top scores get seats",
  FIRST_QUALIFIED: "First to qualify until seats fill",
};

export const QUIZ_MODE_DESCRIPTIONS: Record<QuizMode, string> = {
  TOP_N:
    "Everyone attempts during the window. When you close and allocate, the highest percentages take the seats; ties go to whoever submitted first. The rest are waitlisted in rank order.",
  FIRST_QUALIFIED:
    "Each participant is confirmed the moment they reach the pass score, in submission order, until the seats are full. Later qualifiers are waitlisted even with a higher score.",
};

/** Seconds left in an attempt, never negative. The server clock is authoritative. */
export function attemptSecondsLeft(expiresAt: Date | string, now: Date | string): number {
  return Math.max(0, Math.floor((millis(expiresAt) - millis(now)) / 1000));
}
