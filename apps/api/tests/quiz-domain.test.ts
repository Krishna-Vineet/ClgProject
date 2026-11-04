import { describe, expect, test } from "bun:test";
import {
  allocateTopN,
  attemptSecondsLeft,
  decideFirstQualified,
  isQualified,
  rankAttempts,
  round2,
  scoreAttempt,
} from "@campusops/shared";

/**
 * The rules that decide who gets a seat. Pure, so every tie and boundary can be
 * asserted without a database.
 */
describe("quiz scoring", () => {
  const questions = [
    { id: "q1", correctOptionIndex: 2, points: 1 },
    { id: "q2", correctOptionIndex: 0, points: 2 },
    { id: "q3", correctOptionIndex: 1, points: "1.5" },
  ];

  test("all correct gives 100 percent and the full point total", () => {
    const r = scoreAttempt(questions, { q1: 2, q2: 0, q3: 1 });
    expect(r.score).toBe(4.5);
    expect(r.maxScore).toBe(4.5);
    expect(r.percent).toBe(100);
    expect(r.correctCount).toBe(3);
    expect(r.answeredCount).toBe(3);
  });

  test("unanswered questions score zero and there is no negative marking", () => {
    const r = scoreAttempt(questions, { q1: 0 });
    expect(r.score).toBe(0);
    expect(r.percent).toBe(0);
    expect(r.answeredCount).toBe(1);
    expect(r.correctCount).toBe(0);
  });

  test("weighted questions count their own points", () => {
    const r = scoreAttempt(questions, { q2: 0 });
    expect(r.score).toBe(2);
    expect(r.percent).toBe(round2((2 / 4.5) * 100));
  });

  test("an answer for an unknown question is ignored, not trusted", () => {
    const r = scoreAttempt(questions, { q1: 2, ghost: 1 });
    expect(r.score).toBe(1);
    expect(r.answeredCount).toBe(1);
  });

  test("a negative or fractional option index is not an answer", () => {
    const r = scoreAttempt(questions, { q1: -1, q2: 0.5, q3: 1 });
    expect(r.answeredCount).toBe(1);
    expect(r.score).toBe(1.5);
  });

  test("an empty quiz scores zero rather than dividing by zero", () => {
    const r = scoreAttempt([], {});
    expect(r.percent).toBe(0);
    expect(r.maxScore).toBe(0);
  });
});

describe("qualification", () => {
  test("TOP_N has no pass mark", () => {
    expect(isQualified("TOP_N", 0, null)).toBe(true);
  });
  test("FIRST_QUALIFIED requires a cutoff and compares inclusively", () => {
    expect(isQualified("FIRST_QUALIFIED", 60, null)).toBe(false);
    expect(isQualified("FIRST_QUALIFIED", 59.99, 60)).toBe(false);
    expect(isQualified("FIRST_QUALIFIED", 60, 60)).toBe(true);
    expect(isQualified("FIRST_QUALIFIED", 100, 60)).toBe(true);
  });
});

describe("TOP_N ranking and allocation", () => {
  const attempt = (id: string, percent: number, submittedAt: string) => ({
    id,
    userId: `user-${id}`,
    percent,
    submittedAt,
  });

  test("higher percentage ranks first regardless of submission order", () => {
    const ranked = rankAttempts([
      attempt("a", 70, "2026-01-01T10:00:00Z"),
      attempt("b", 90, "2026-01-01T11:00:00Z"),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["b", "a"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
  });

  test("a tie goes to whoever submitted first", () => {
    const ranked = rankAttempts([
      attempt("late", 80, "2026-01-01T12:00:00Z"),
      attempt("early", 80, "2026-01-01T09:00:00Z"),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["early", "late"]);
  });

  test("identical score and instant still produce a total, reproducible order", () => {
    const input = [
      attempt("b", 80, "2026-01-01T09:00:00Z"),
      attempt("a", 80, "2026-01-01T09:00:00Z"),
      attempt("c", 80, "2026-01-01T09:00:00Z"),
    ];
    const once = rankAttempts(input).map((r) => r.id);
    const twice = rankAttempts([...input].reverse()).map((r) => r.id);
    expect(once).toEqual(["a", "b", "c"]);
    expect(twice).toEqual(once);
  });

  test("the first N are confirmed and the rest waitlist in rank order", () => {
    const rows = allocateTopN(
      [
        attempt("a", 95, "2026-01-01T09:00:00Z"),
        attempt("b", 85, "2026-01-01T09:10:00Z"),
        attempt("c", 75, "2026-01-01T09:20:00Z"),
      ],
      2,
    );
    expect(rows.map((r) => r.outcome)).toEqual(["CONFIRMED", "CONFIRMED", "WAITLISTED"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  test("zero seats waitlists everyone; more seats than attempts confirms everyone", () => {
    const input = [attempt("a", 90, "2026-01-01T09:00:00Z")];
    expect(allocateTopN(input, 0)[0]?.outcome).toBe("WAITLISTED");
    expect(allocateTopN(input, 10)[0]?.outcome).toBe("CONFIRMED");
  });

  test("ranking does not mutate the caller's array", () => {
    const input = [
      attempt("a", 10, "2026-01-01T09:00:00Z"),
      attempt("b", 90, "2026-01-01T09:00:00Z"),
    ];
    rankAttempts(input);
    expect(input.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("FIRST_QUALIFIED allocation", () => {
  test("a qualifier takes a free seat", () => {
    expect(decideFirstQualified({ percent: 80, passScore: 60, seats: 10, seatsTaken: 3 })).toEqual({
      qualified: true,
      outcome: "CONFIRMED",
    });
  });

  test("the last seat is confirmable and the next qualifier waitlists", () => {
    expect(
      decideFirstQualified({ percent: 100, passScore: 60, seats: 5, seatsTaken: 4 }).outcome,
    ).toBe("CONFIRMED");
    expect(
      decideFirstQualified({ percent: 100, passScore: 60, seats: 5, seatsTaken: 5 }).outcome,
    ).toBe("WAITLISTED");
  });

  test("a perfect score still waitlists once the seats are gone", () => {
    const r = decideFirstQualified({ percent: 100, passScore: 50, seats: 1, seatsTaken: 1 });
    expect(r.qualified).toBe(true);
    expect(r.outcome).toBe("WAITLISTED");
  });

  test("below the cutoff is rejected, not waitlisted", () => {
    expect(decideFirstQualified({ percent: 40, passScore: 60, seats: 10, seatsTaken: 0 })).toEqual({
      qualified: false,
      outcome: "REJECTED",
    });
  });

  test("no seats configured means nobody is confirmed", () => {
    expect(
      decideFirstQualified({ percent: 100, passScore: 60, seats: 0, seatsTaken: 0 }).outcome,
    ).toBe("WAITLISTED");
  });
});

describe("attempt clock", () => {
  test("seconds left is floored and never negative", () => {
    expect(attemptSecondsLeft("2026-01-01T10:00:30Z", "2026-01-01T10:00:00Z")).toBe(30);
    expect(attemptSecondsLeft("2026-01-01T10:00:00Z", "2026-01-01T10:05:00Z")).toBe(0);
  });
});
