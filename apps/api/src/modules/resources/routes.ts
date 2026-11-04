import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ApiError } from "../../utils/api-error";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

export const resourceRoutes = new Hono();
resourceRoutes.use("*", authenticate, requireActiveAccount);

/** Inventory and availability are for staff and club coordinators, not general students. */
const requireInventoryReader = createMiddleware(async (c, next) => {
  const auth = c.get("auth");
  if (auth.roles.length === 0 && auth.memberships.length === 0)
    throw new ApiError(
      "FORBIDDEN",
      "Resource inventory is available to staff and club coordinators.",
    );
  await next();
});

resourceRoutes.use("*", requireInventoryReader);

resourceRoutes.get("/", async (c) =>
  ok(c, await service.listResources(c.get("auth"), parseQuery(c, schemas.resourceListQuerySchema))),
);

resourceRoutes.get("/availability", async (c) =>
  ok(c, await service.availability(parseQuery(c, schemas.availabilityQuerySchema))),
);

resourceRoutes.get("/calendar", async (c) =>
  ok(c, await service.calendar(c.get("auth"), parseQuery(c, schemas.calendarQuerySchema))),
);

resourceRoutes.post("/", async (c) => {
  const input = await parseJson(c, schemas.createResourceSchema);
  return ok(c, await service.createResource(c.get("auth"), input, auditContext(c)), 201);
});

resourceRoutes.get("/:id", async (c) => ok(c, await service.getResource(c.req.param("id"))));

resourceRoutes.patch("/:id", async (c) => {
  const input = await parseJson(c, schemas.updateResourceSchema);
  return ok(
    c,
    await service.updateResource(c.get("auth"), c.req.param("id"), input, auditContext(c)),
  );
});

resourceRoutes.post("/:id/units", async (c) => {
  const input = await parseJson(c, schemas.createUnitSchema);
  return ok(
    c,
    await service.createUnit(c.get("auth"), c.req.param("id"), input, auditContext(c)),
    201,
  );
});

export const resourceUnitRoutes = new Hono();
resourceUnitRoutes.use("*", authenticate, requireActiveAccount, requireInventoryReader);
resourceUnitRoutes.patch("/:id", async (c) => {
  const input = await parseJson(c, schemas.updateUnitSchema);
  return ok(c, await service.updateUnit(c.get("auth"), c.req.param("id"), input, auditContext(c)));
});
