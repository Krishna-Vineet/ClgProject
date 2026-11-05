import { Hono } from "hono";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import {
  assertEventManage,
  assertEventOrganiserRead,
  requireEventManage,
  requireEventOrganiserRead,
} from "../../middleware/event-scope";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

/** Organiser posting, mounted under /events. */
export const eventAnnouncementRoutes = new Hono();
eventAnnouncementRoutes.use("*", authenticate, requireActiveAccount);

eventAnnouncementRoutes.get("/:id/announcements", requireEventOrganiserRead(), async (c) => {
  const page = parseQuery(c, schemas.announcementListQuerySchema);
  return ok(
    c,
    await service.listForOrganiser(c.get("auth"), c.req.param("id"), page.limit, page.offset),
  );
});

eventAnnouncementRoutes.post(
  "/:id/announcements",
  requireEventManage(),
  rateLimit({ windowMs: 60_000, max: 10, prefix: "announcement-post", keyBy: "user" }),
  async (c) => {
    const input = await parseJson(c, schemas.createAnnouncementSchema);
    return ok(
      c,
      await service.create(c.get("auth"), c.req.param("id"), input, auditContext(c)),
      201,
    );
  },
);

export const announcementRoutes = new Hono();
announcementRoutes.use("*", authenticate, requireActiveAccount);

announcementRoutes.post("/:id/revoke", async (c) =>
  ok(c, await service.revoke(c.get("auth"), c.req.param("id"), auditContext(c))),
);

/** Participant inbox and read state, mounted before /me. */
export const myAnnouncementRoutes = new Hono();
myAnnouncementRoutes.use("*", authenticate, requireActiveAccount);

myAnnouncementRoutes.get("/", async (c) => {
  const page = parseQuery(c, schemas.announcementListQuerySchema);
  return ok(c, await service.myInbox(c.get("auth"), page.limit, page.offset));
});

myAnnouncementRoutes.post("/:id/read", async (c) =>
  ok(c, await service.markRead(c.get("auth"), c.req.param("id"))),
);

/** Clear the whole unread badge at once, for "I have seen the inbox". */
myAnnouncementRoutes.post("/read-all", async (c) =>
  ok(c, await service.markAllRead(c.get("auth"))),
);

/** Device registration for push, mounted under /me/devices. */
export const myDeviceRoutes = new Hono();
myDeviceRoutes.use("*", authenticate, requireActiveAccount);

myDeviceRoutes.get("/", async (c) => ok(c, await service.myDevices(c.get("auth"))));

myDeviceRoutes.post(
  "/",
  rateLimit({ windowMs: 60_000, max: 20, prefix: "device-register", keyBy: "user" }),
  async (c) => {
    const input = await parseJson(c, schemas.registerDeviceSchema);
    return ok(c, await service.registerDevice(c.get("auth"), input));
  },
);

myDeviceRoutes.post("/remove", async (c) => {
  const input = await parseJson(c, schemas.removeDeviceSchema);
  return ok(c, await service.removeDevice(c.get("auth"), input.expoPushToken));
});

export { assertEventManage, assertEventOrganiserRead };
