import { offsetPaginationSchema } from "@campusops/shared";
import { Hono } from "hono";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import { requireEventManage, requireEventOrganiserRead } from "../../middleware/event-scope";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ApiError } from "../../utils/api-error";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

/** Event-scoped complaint locations and the coordinator inbox. */
export const eventComplaintRoutes = new Hono();
eventComplaintRoutes.use("*", authenticate, requireActiveAccount);

eventComplaintRoutes.get("/:id/complaint-locations", requireEventOrganiserRead(), async (c) =>
  ok(c, { items: await service.listLocations(c.req.param("id")) }),
);

eventComplaintRoutes.post("/:id/complaint-locations", requireEventManage(), async (c) => {
  const input = await parseJson(c, schemas.createLocationSchema);
  return ok(
    c,
    await service.createLocation(c.get("auth"), c.req.param("id"), input, auditContext(c)),
    201,
  );
});

eventComplaintRoutes.get("/:id/complaints", requireEventOrganiserRead(), async (c) =>
  ok(c, await service.list(c.req.param("id"), parseQuery(c, schemas.complaintListQuerySchema))),
);

eventComplaintRoutes.get("/:id/complaints/summary", requireEventOrganiserRead(), async (c) =>
  ok(c, await service.summary(c.req.param("id"))),
);

/** Locations addressed directly, including the printable poster. */
export const myComplaintRoutes = new Hono();
myComplaintRoutes.use("*", authenticate, requireActiveAccount);
myComplaintRoutes.get("/", async (c) => {
  const page = parseQuery(c, offsetPaginationSchema);
  return ok(c, await service.mine(c.get("auth"), page.limit, page.offset));
});

export const complaintRoutes = new Hono();
complaintRoutes.use("*", authenticate, requireActiveAccount);

complaintRoutes.patch("/locations/:id", async (c) => {
  const input = await parseJson(c, schemas.updateLocationSchema);
  const auth = c.get("auth");
  const location = await service.loadLocation(c.req.param("id"));
  await service.assertEventManage(auth, location.eventId);
  return ok(c, await service.updateLocation(location.id, input, auditContext(c)));
});

complaintRoutes.get("/locations/:id/poster", async (c) => {
  const auth = c.get("auth");
  const location = await service.loadLocation(c.req.param("id"));
  await service.assertEventRead(auth, location.eventId);
  const bytes = await service.poster(location.id);
  const reference = location.id.slice(0, 8);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="report-issue-${reference}.pdf"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/** Mobile: resolve a scanned code, then raise a report against it. */
complaintRoutes.get("/locations/:id", async (c) =>
  ok(c, await service.resolveLocation(c.get("auth"), c.req.param("id"))),
);

complaintRoutes.post("/locations/:id/reports", async (c) => {
  const input = await parseJson(c, schemas.raiseComplaintSchema);
  return ok(c, await service.raise(c.get("auth"), c.req.param("id"), input), 201);
});

complaintRoutes.get("/:id", async (c) =>
  ok(c, await service.detail(c.get("auth"), c.req.param("id"))),
);

complaintRoutes.patch("/:id", async (c) => {
  const input = await parseJson(c, schemas.updateComplaintSchema);
  return ok(c, await service.update(c.get("auth"), c.req.param("id"), input, auditContext(c)));
});
