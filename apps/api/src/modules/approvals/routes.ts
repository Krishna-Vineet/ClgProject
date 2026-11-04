import { APPROVAL_TIERS } from "@campusops/shared";
import { Hono } from "hono";
import { z } from "zod";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ApiError } from "../../utils/api-error";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

export const approvalRoutes = new Hono();
approvalRoutes.use("*", authenticate, requireActiveAccount);

approvalRoutes.get("/inbox", async (c) =>
  ok(c, await service.inbox(c.get("auth"), parseQuery(c, schemas.approvalInboxQuerySchema))),
);

approvalRoutes.get("/approvers", async (c) => {
  const { tier } = parseQuery(c, z.object({ tier: z.enum(APPROVAL_TIERS).default("FACULTY") }));
  return ok(c, { items: await service.availableApprovers(c.get("auth"), tier) });
});

export const approvalRequestRoutes = new Hono();
approvalRequestRoutes.use("*", authenticate, requireActiveAccount);

approvalRequestRoutes.get("/:id", async (c) =>
  ok(c, await service.getRequest(c.get("auth"), c.req.param("id"))),
);

approvalRequestRoutes.post(
  "/:id/decision",
  rateLimit({ windowMs: 60_000, max: 60, prefix: "approval-decision" }),
  async (c) => {
    const input = await parseJson(c, schemas.decisionSchema);
    return ok(c, await service.decide(c.get("auth"), c.req.param("id"), input, auditContext(c)));
  },
);

approvalRequestRoutes.post("/:id/escalate", async (c) => {
  const input = await parseJson(c, schemas.escalateSchema);
  return ok(c, await service.escalate(c.get("auth"), c.req.param("id"), input, auditContext(c)));
});

approvalRequestRoutes.post("/:id/reassign", async (c) => {
  const input = await parseJson(c, schemas.reassignSchema);
  return ok(c, await service.reassign(c.get("auth"), c.req.param("id"), input, auditContext(c)));
});

approvalRequestRoutes.post("/:id/cancel", async (c) => {
  const input = await parseJson(c, schemas.cancelRequestSchema);
  return ok(
    c,
    await service.cancelRequest(c.get("auth"), c.req.param("id"), input, auditContext(c)),
  );
});

approvalRequestRoutes.post("/:id/resources", async (c) => {
  const input = await parseJson(c, schemas.attachResourcesSchema);
  return ok(
    c,
    await service.attachResources(c.get("auth"), c.req.param("id"), input, auditContext(c)),
  );
});
