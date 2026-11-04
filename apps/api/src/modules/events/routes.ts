import { Hono } from "hono";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import { requireClubManage, requireClubRead } from "../../middleware/club-scope";
import {
  requireEventManage,
  requireEventOperationalRead,
  requireEventOrganiserRead,
} from "../../middleware/event-scope";
import { idempotent } from "../../middleware/idempotency";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";
import { addApprovalRequestSchema, approvalInboxQuerySchema } from "../approvals/schemas";
import * as approvals from "../approvals/service";
import { eventAuditHandler } from "../audit/routes";
import { auditContext } from "../audit/service";
import {
  downloadReportHandler,
  generateReportHandler,
  getReportHandler,
  listReportsHandler,
  previewReportHandler,
  reportRateLimit,
} from "../reports/routes";
import { eventReservations } from "../resources/service";
import * as schemas from "./schemas";
import * as service from "./service";
import * as visibility from "./visibility";

export const eventRoutes = new Hono();
eventRoutes.use("*", authenticate, requireActiveAccount);

eventRoutes.get("/", async (c) =>
  ok(
    c,
    await visibility.listVisibleEvents(c.get("auth"), parseQuery(c, schemas.eventListQuerySchema)),
  ),
);

eventRoutes.post(
  "/",
  rateLimit({ windowMs: 60_000, max: 20, prefix: "event-create" }),
  idempotent("event-create"),
  async (c) => {
    const input = await parseJson(c, schemas.createEventSchema);
    return ok(c, await service.createEvent(c.get("auth"), input, auditContext(c)), 201);
  },
);

eventRoutes.get("/:id", async (c) =>
  ok(c, await visibility.getVisibleEvent(c.get("auth"), c.req.param("id"))),
);

eventRoutes.get("/:id/calendar.ics", async (c) => {
  const event = await visibility.getVisibleEvent(c.get("auth"), c.req.param("id"));
  const stamp = (value: Date) =>
    value
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const fold = (value: string) => value.replace(/([,;\\])/g, "\\$1").replace(/\r?\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CampusOps//Event//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@campusops`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(new Date(event.startsAt))}`,
    `DTEND:${stamp(new Date(event.endsAt))}`,
    `SUMMARY:${fold(event.title)}`,
    `LOCATION:${fold(event.venueSummary ?? "")}`,
    `DESCRIPTION:${fold(event.description ?? "")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  c.header("content-type", "text/calendar; charset=utf-8");
  c.header("content-disposition", `attachment; filename="${event.slug}.ics"`);
  return c.body(lines.join("\r\n"));
});

eventRoutes.patch("/:id", requireEventManage(), async (c) => {
  const input = await parseJson(c, schemas.updateEventSchema);
  return ok(c, await service.updateEvent(c.get("auth"), c.req.param("id"), input, auditContext(c)));
});

eventRoutes.post("/:id/submit", requireEventManage(), idempotent("event-submit"), async (c) => {
  const input = await parseJson(c, schemas.submitEventSchema);
  return ok(c, await service.submitEvent(c.get("auth"), c.req.param("id"), input, auditContext(c)));
});

eventRoutes.post("/:id/revisions", requireEventManage(), async (c) => {
  const input = await parseJson(c, schemas.reviseEventSchema);
  return ok(
    c,
    await service.createRevision(c.get("auth"), c.req.param("id"), input, auditContext(c)),
    201,
  );
});

eventRoutes.get("/:id/revisions", requireEventOperationalRead(), async (c) =>
  ok(c, { items: await service.listRevisions(c.get("auth"), c.req.param("id")) }),
);

eventRoutes.post("/:id/publish", requireEventManage(), async (c) => {
  const input = await parseJson(c, schemas.publishEventSchema);
  return ok(
    c,
    await service.publishEvent(c.get("auth"), c.req.param("id"), input, auditContext(c)),
  );
});

eventRoutes.post("/:id/cancel", async (c) => {
  const input = await parseJson(c, schemas.cancelEventSchema);
  return ok(c, await service.cancelEvent(c.get("auth"), c.req.param("id"), input, auditContext(c)));
});

eventRoutes.post("/:id/start", requireEventManage(), async (c) =>
  ok(c, await service.startEvent(c.get("auth"), c.req.param("id"), auditContext(c))),
);

eventRoutes.post("/:id/complete", requireEventManage(), async (c) => {
  const input = await parseJson(c, schemas.completeEventSchema);
  return ok(
    c,
    await service.completeEvent(c.get("auth"), c.req.param("id"), input, auditContext(c)),
  );
});

eventRoutes.get("/:id/eligibility-preview", async (c) =>
  ok(c, await service.eligibilityPreview(c.get("auth"), c.req.param("id"))),
);

eventRoutes.get("/:id/approval-bundle", requireEventOperationalRead(), async (c) =>
  ok(c, await approvals.eventBundle(c.get("auth"), c.req.param("id"))),
);

eventRoutes.post("/:id/approval-requests", requireEventManage(), async (c) => {
  const input = await parseJson(c, addApprovalRequestSchema);
  return ok(
    c,
    await approvals.addRequest(c.get("auth"), c.req.param("id"), input, auditContext(c)),
    201,
  );
});

eventRoutes.get("/:id/audit", requireEventOperationalRead(), eventAuditHandler);

// Post-event reports. Access is narrowed further inside assertReportAccess:
// event-operational read is necessary but not sufficient.
eventRoutes.post(
  "/:id/reports",
  requireEventOperationalRead(),
  reportRateLimit,
  generateReportHandler,
);
eventRoutes.get("/:id/reports", requireEventOperationalRead(), listReportsHandler);
eventRoutes.get("/:id/report-preview", requireEventOperationalRead(), previewReportHandler);
eventRoutes.get("/:id/reports/:reportId", requireEventOperationalRead(), getReportHandler);
eventRoutes.get("/:id/reports/:reportId/pdf", requireEventOperationalRead(), downloadReportHandler);

eventRoutes.get("/:id/reservations", requireEventOperationalRead(), async (c) =>
  ok(c, { items: await eventReservations(c.req.param("id")) }),
);

eventRoutes.get("/:id/invitations", requireEventOrganiserRead(), async (c) =>
  ok(c, { items: await service.listInvitations(c.get("auth"), c.req.param("id")) }),
);

eventRoutes.post("/:id/invitations", requireEventManage(), async (c) => {
  const input = await parseJson(c, schemas.inviteSchema);
  return ok(c, await service.invite(c.get("auth"), c.req.param("id"), input, auditContext(c)), 201);
});

eventRoutes.delete("/:id/invitations/:inviteId", requireEventManage(), async (c) =>
  ok(
    c,
    await service.revokeInvitation(
      c.get("auth"),
      c.req.param("id"),
      c.req.param("inviteId"),
      auditContext(c),
    ),
  ),
);

export const clubEventRoutes = new Hono();
clubEventRoutes.use("*", authenticate, requireActiveAccount);
clubEventRoutes.get("/:id/events", requireClubRead(), async (c) =>
  ok(
    c,
    await service.listClubEventsScoped(
      c.req.param("id"),
      parseQuery(c, schemas.eventListQuerySchema),
    ),
  ),
);

export const myEventRoutes = new Hono();
myEventRoutes.use("*", authenticate, requireActiveAccount);
myEventRoutes.get("/", async (c) => {
  const page = parseQuery(c, schemas.eventListQuerySchema);
  return ok(c, await service.myManagedEvents(c.get("auth"), page));
});
