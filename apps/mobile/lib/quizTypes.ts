/** Shapes returned by the participant quiz endpoints. */
export type ParticipantQuiz = {
  quiz: {
    id: string;
    mode: "TOP_N" | "FIRST_QUALIFIED";
    status: "DRAFT" | "PUBLISHED" | "PAUSED" | "CLOSED";
    opensAt: string;
    closesAt: string;
    durationSeconds: number;
    passScore: number | null;
    instructions: string;
    questionCount: number;
    maxScore: number;
    allocatedAt: string | null;
  } | null;
  attempt: {
    id: string;
    status: "IN_PROGRESS" | "SUBMITTED" | "EXPIRED";
    startedAt: string;
    expiresAt: string;
    submittedAt: string | null;
    secondsLeft: number;
    score: number | null;
    percentScore: number | null;
    qualified: boolean | null;
    rank: number | null;
    allocatedStatus: "CONFIRMED" | "WAITLISTED" | "REJECTED" | null;
  } | null;
  registration?: {
    id: string;
    status: string;
    queuePosition: number | null;
  } | null;
  windowOpen?: boolean;
  /** Clock-derived state, so the phone never has to re-derive the window. */
  phase?: "DRAFT" | "BEFORE_OPEN" | "OPEN" | "PAUSED" | "WINDOW_CLOSED" | "CLOSED";
};

export type Paper = {
  attemptId: string;
  status: string;
  expiresAt: string;
  secondsLeft: number;
  answers: Record<string, number>;
  /** Deliberately has no correct-answer field: the key stays on the server. */
  questions: Array<{ id: string; prompt: string; options: string[]; points: number }>;
};

export type QuizResult = {
  alreadySubmitted: boolean;
  score: number | null;
  maxScore: number;
  percentScore: number | null;
  qualified: boolean | null;
  outcome: "CONFIRMED" | "WAITLISTED" | "REJECTED" | null;
  rank: number | null;
  correctCount?: number;
  totalQuestions?: number;
  expired?: boolean;
};

export type Announcement = {
  id: string;
  title: string;
  body: string;
  isPinned: boolean;
  publishedAt: string;
  readAt: string | null;
  event: { id: string; title: string };
};
