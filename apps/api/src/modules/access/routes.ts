import { Hono } from "hono";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import { requireEventManage, requireEventOrganiserRead } from "../../middleware/event-scope";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ApiError } from "../../utils/api-error";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

/** Event-scoped access QR configuration and monitoring, used by the portal. */
export const eventAccessRoutes = new Hono();
eventAccessRoutes.use("*", authenticate, requireActiveAccount);

eventAccessRoutes.get("/:id/checkpoints", requireEventOrganiserRead(), async (c) =>
  ok(c, { items: await service.listCheckpoints(c.req.param("id")) }),
);

eventAccessRoutes.post("/:id/checkpoints", requireEventManage(), async (c) => {
  const input = await parseJson(c, schemas.createCheckpointSchema);
  return ok(
    c,
    await service.createCheckpoint(c.get("auth"), c.req.param("id"), input, auditContext(c)),
    201,
  );
});

eventAccessRoutes.post("/:id/passes/issue", requireEventManage(), async (c) =>
  ok(c, await service.issuePasses(c.req.param("id"), auditContext(c))),
);

eventAccessRoutes.get("/:id/passes", requireEventOrganiserRead(), async (c) =>
  ok(c, { items: await service.listPasses(c.req.param("id")) }),
);

eventAccessRoutes.get("/:id/access-log", requireEventOrganiserRead(), async (c) =>
  ok(c, await service.accessLog(c.req.param("id"), parseQuery(c, schemas.accessLogQuerySchema))),
);

/** Counters and passes addressed directly. */
export const accessRoutes = new Hono();
accessRoutes.use("*", authenticate, requireActiveAccount);

accessRoutes.patch("/checkpoints/:id/active", async (c) => {
  const input = await parseJson(c, schemas.setQrActiveSchema);
  const cp = await service.assertCheckpointManageable(c.get("auth"), c.req.param("id"));
  return ok(c, await service.setCheckpointActive(cp.id, input.isActive, auditContext(c)));
});

accessRoutes.patch("/checkpoints/:id", async (c) => {
  const input = await parseJson(c, schemas.updateCheckpointSchema);
  const cp = await service.assertCheckpointManageable(c.get("auth"), c.req.param("id"));
  return ok(c, await service.updateCheckpoint(cp.id, input, auditContext(c)));
});

accessRoutes.delete("/checkpoints/:id", async (c) => {
  const cp = await service.assertCheckpointManageable(c.get("auth"), c.req.param("id"));
  return ok(c, await service.deleteCheckpoint(cp.id, auditContext(c)));
});

accessRoutes.post("/passes/:id/revoke", async (c) => {
  await service.assertPassManageable(c.get("auth"), c.req.param("id"));
  return ok(c, await service.revokePass(c.req.param("id"), auditContext(c)));
});

/** The organiser's scanner. Coordinators and club faculty, not a separate role. */
accessRoutes.post("/inspect", async (c) => {
  const input = await parseJson(c, schemas.inspectScanSchema);
  return ok(c, await service.inspectScan(c.get("auth"), input));
});

accessRoutes.post(
  "/scans/sync",
  rateLimit({ windowMs: 60_000, max: 30, prefix: "scan-sync", keyBy: "user" }),
  async (c) => {
    const input = await parseJson(c, schemas.syncOfflineScansSchema);
    const { env } = await import("../../config/env");
    if (input.items.length > env.OFFLINE_SCAN_BATCH_MAX)
      throw new ApiError(
        "VALIDATION_ERROR",
        `Sync at most ${env.OFFLINE_SCAN_BATCH_MAX} scans per request.`,
      );
    return ok(c, await service.syncOfflineScans(c.get("auth"), input.items));
  },
);

accessRoutes.post("/scan", async (c) => {
  const input = await parseJson(c, schemas.scanSchema);
  return ok(c, await service.scan(c.get("auth"), input));
});

/** Participant wallet. Consumed by the mobile app. */
export const myPassRoutes = new Hono();
myPassRoutes.use("*", authenticate, requireActiveAccount);

myPassRoutes.get("/", async (c) => ok(c, await service.myPasses(c.get("auth"))));
myPassRoutes.post(
  "/:id/nonce",
  // A code is refreshed roughly once a minute per counter; 60/min leaves room
  // for several counters on screen without allowing a mint flood. Keyed by
  // account, not address: a whole venue shares one public IP.
  rateLimit({ windowMs: 60_000, max: 60, prefix: "qr-mint", keyBy: "user" }),
  async (c) => {
    const input = await parseJson(c, schemas.mintNonceSchema);
    return ok(c, await service.mintNonce(c.get("auth"), c.req.param("id"), input.checkpointId));
  },
);
