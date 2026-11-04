import { APPLICATION_DECISIONS, offsetPaginationSchema } from "@campusops/shared";
import { Hono } from "hono";
import { z } from "zod";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import { idempotent } from "../../middleware/idempotency";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as lifecycle from "./lifecycle";
import * as service from "./service";

const registerSchema = z.object({}).strict();

export const withdrawSchema = z.object({ reason: z.string().trim().max(300).optional() }).strict();

export const removeParticipantSchema = z
  .object({ reason: z.string().trim().min(3).max(300) })
  .strict();

export const decideApplicationSchema = z
  .object({
    decision: z.enum(APPLICATION_DECISIONS),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export const rosterQuerySchema = z
  .object({
    status: z.enum(["APPLIED", "CONFIRMED", "WAITLISTED", "REJECTED", "CANCELLED"]).optional(),
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();

/** Participant-facing registration, mounted under /events. */
export const eventRegistrationRoutes = new Hono();
eventRegistrationRoutes.use("*", authenticate, requireActiveAccount);
eventRegistrationRoutes.get("/:id/participant", async (c) =>
  ok(c, await service.participantView(c.get("auth"), c.req.param("id"))),
);
eventRegistrationRoutes.post(
  "/:id/register",
  rateLimit({ windowMs: 60_000, max: 12, prefix: "participant-register", keyBy: "user" }),
  idempotent("participant-register"),
  async (c) => {
    await parseJson(c, registerSchema);
    const result = await service.register(c.get("auth"), c.req.param("id"), auditContext(c));
    return ok(c, result, result.alreadyRegistered ? 200 : 201);
  },
);

eventRegistrationRoutes.post("/:id/withdraw", async (c) => {
  const input = await parseJson(c, withdrawSchema);
  return ok(
    c,
    await lifecycle.withdraw(c.get("auth"), c.req.param("id"), input.reason, auditContext(c)),
  );
});

eventRegistrationRoutes.get("/:id/registration-history", async (c) =>
  ok(c, await lifecycle.myHistory(c.get("auth"), c.req.param("id"))),
);

/** The phone's own registration list, mounted before /me. */
export const myRegistrationRoutes = new Hono();
myRegistrationRoutes.use("*", authenticate, requireActiveAccount);
myRegistrationRoutes.get("/", async (c) => {
  const page = parseQuery(c, offsetPaginationSchema);
  return ok(c, await service.mine(c.get("auth"), page.limit, page.offset));
});

export { registerSchema };

/** Organiser roster and decisions, mounted under /events after the public routes. */
export const eventRosterRoutes = new Hono();
eventRosterRoutes.use("*", authenticate, requireActiveAccount);

eventRosterRoutes.get("/:id/registrations.csv", async (c) => {
  const result = await lifecycle.rosterCsv(c.get("auth"), c.req.param("id"));
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="${result.filename}"`);
  return c.body(result.csv);
});

eventRosterRoutes.get("/:id/registrations", async (c) => {
  const query = parseQuery(c, rosterQuerySchema);
  return ok(c, await lifecycle.roster(c.get("auth"), c.req.param("id"), query));
});

eventRosterRoutes.post("/:id/registrations/:registrationId/decision", async (c) => {
  const input = await parseJson(c, decideApplicationSchema);
  return ok(
    c,
    await lifecycle.decideApplication(
      c.get("auth"),
      c.req.param("id"),
      c.req.param("registrationId"),
      input.decision,
      input.note,
      auditContext(c),
    ),
  );
});

eventRosterRoutes.post("/:id/registrations/:registrationId/remove", async (c) => {
  const input = await parseJson(c, removeParticipantSchema);
  return ok(
    c,
    await lifecycle.removeParticipant(
      c.get("auth"),
      c.req.param("id"),
      c.req.param("registrationId"),
      input.reason,
      auditContext(c),
    ),
  );
});
