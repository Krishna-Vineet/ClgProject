import { Hono } from "hono";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import {
  assertEventManage,
  assertEventOrganiserRead,
  requireEventManage,
  requireEventOrganiserRead,
} from "../../middleware/event-scope";
import { idempotent } from "../../middleware/idempotency";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

/** Event-scoped quiz configuration and the participant's own attempt. */
export const eventQuizRoutes = new Hono();
eventQuizRoutes.use("*", authenticate, requireActiveAccount);

eventQuizRoutes.get("/:id/quiz", requireEventOrganiserRead(), async (c) =>
  ok(c, await service.getForOrganiser(c.get("auth"), c.req.param("id"))),
);

eventQuizRoutes.put("/:id/quiz", requireEventManage(), async (c) => {
  const input = await parseJson(c, schemas.createQuizSchema);
  return ok(c, await service.upsertQuiz(c.get("auth"), c.req.param("id"), input, auditContext(c)));
});

eventQuizRoutes.get("/:id/quiz/me", async (c) =>
  ok(c, await service.participantView(c.get("auth"), c.req.param("id"))),
);

eventQuizRoutes.post(
  "/:id/quiz/attempts",
  rateLimit({ windowMs: 60_000, max: 20, prefix: "quiz-start", keyBy: "user" }),
  async (c) =>
    ok(c, await service.startAttempt(c.get("auth"), c.req.param("id"), auditContext(c)), 201),
);

eventQuizRoutes.post(
  "/:id/quiz/attempts/submit",
  rateLimit({ windowMs: 60_000, max: 20, prefix: "quiz-submit", keyBy: "user" }),
  idempotent("quiz-submit"),
  async (c) => {
    const input = await parseJson(c, schemas.submitAttemptSchema);
    return ok(
      c,
      await service.submitAttempt(c.get("auth"), c.req.param("id"), input, auditContext(c)),
    );
  },
);

/** Quiz addressed directly, for organiser actions once the quiz id is known. */
export const quizRoutes = new Hono();
quizRoutes.use("*", authenticate, requireActiveAccount);

quizRoutes.patch("/:id/status", async (c) => {
  const input = await parseJson(c, schemas.setQuizStatusSchema);
  const quiz = await service.loadQuiz(c.req.param("id"));
  await assertEventManage(c.get("auth"), quiz.eventId);
  return ok(c, await service.setStatus(quiz.id, input.status, auditContext(c)));
});

quizRoutes.post("/:id/allocate", idempotent("quiz-allocate"), async (c) => {
  const input = await parseJson(c, schemas.allocateSchema);
  const quiz = await service.loadQuiz(c.req.param("id"));
  await assertEventManage(c.get("auth"), quiz.eventId);
  return ok(c, await service.allocate(quiz.id, input.note, auditContext(c)));
});

quizRoutes.get("/:id/leaderboard", async (c) => {
  const quiz = await service.loadQuiz(c.req.param("id"));
  await assertEventOrganiserRead(c.get("auth"), quiz.eventId);
  const page = parseQuery(c, schemas.leaderboardQuerySchema);
  return ok(c, await service.leaderboard(quiz.id, page.limit, page.offset));
});
