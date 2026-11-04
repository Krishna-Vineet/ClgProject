import { IMPLEMENTATION_PHASE } from "@campusops/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { effectiveEmailMode, env, shouldExposeDemoOtp } from "./config/env";
import { errorHandler } from "./middleware/error-handler";
import { idempotent } from "./middleware/idempotency";
import { opportunisticMaintenance } from "./middleware/maintenance";
import { requestId } from "./middleware/request-id";
import { accessRoutes, eventAccessRoutes, myPassRoutes } from "./modules/access/routes";
import { adminRoutes } from "./modules/admin/routes";
import {
  announcementRoutes,
  eventAnnouncementRoutes,
  myAnnouncementRoutes,
  myDeviceRoutes,
} from "./modules/announcements/routes";
import { approvalRequestRoutes, approvalRoutes } from "./modules/approvals/routes";
import { authRoutes, meRoutes } from "./modules/auth/routes";
import { clubRoutes, myClubRoutes } from "./modules/clubs/routes";
import {
  complaintRoutes,
  eventComplaintRoutes,
  myComplaintRoutes,
} from "./modules/complaints/routes";
import { dashboardRoutes } from "./modules/dashboard/routes";
import { departmentRoutes } from "./modules/departments/routes";
import { clubEventRoutes, eventRoutes, myEventRoutes } from "./modules/events/routes";
import { facultyRoutes } from "./modules/faculty/routes";
import { healthRoutes } from "./modules/health/routes";
import { jobRoutes } from "./modules/jobs/routes";
import { eventQuizRoutes, quizRoutes } from "./modules/quizzes/routes";
import { eventRosterRoutes } from "./modules/registrations/routes";
import { eventRegistrationRoutes, myRegistrationRoutes } from "./modules/registrations/routes";
import { resourceRoutes, resourceUnitRoutes } from "./modules/resources/routes";
import { searchRoutes } from "./modules/search/routes";
import { storageRoutes } from "./modules/storage/routes";
import { buildOpenApiSpec } from "./openapi/spec";
import { ApiError } from "./utils/api-error";
import { log } from "./utils/logger";
import { ok } from "./utils/response";

export function createApp() {
  const app = new Hono();
  app.use("*", requestId);
  app.use("*", secureHeaders());
  app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const ms = Math.round(performance.now() - started);
    c.header("X-Response-Time", `${ms}ms`);
    if (ms > 1500)
      log.warn("slow_request", {
        requestId: c.get("requestId") ?? null,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
      });
  });
  app.use("*", opportunisticMaintenance);
  app.use(
    "*",
    cors({
      origin: [env.WEB_ORIGIN],
      allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      maxAge: 600,
    }),
  );
  app.onError(errorHandler);
  app.get("/", (c) =>
    ok(c, { name: "CampusOps API", phase: IMPLEMENTATION_PHASE, docs: "/health/live" }),
  );
  app.get("/api/v1/config", (c) =>
    ok(c, {
      demoMode: env.DEMO_MODE,
      emailMode: effectiveEmailMode(),
      exposeDemoOtp: shouldExposeDemoOtp(),
      storageMode: env.STORAGE_MODE,
      campusTimezone: env.CAMPUS_TIMEZONE,
      institutionName: env.INSTITUTION_NAME,
      complaintQrBase: env.COMPLAINT_QR_BASE,
    }),
  );
  const openApiSpec = buildOpenApiSpec();
  app.get("/api/v1/openapi.json", (c) => c.json(openApiSpec));
  app.route("/health", healthRoutes);
  app.route("/api/v1/health", healthRoutes);
  app.route("/api/v1/jobs", jobRoutes);
  app.use("/api/v1/auth/register/*", idempotent("auth-register"));
  app.use("/api/v1/admin/staff", idempotent("admin-staff"));
  app.route("/api/v1/auth", authRoutes);
  app.route("/api/v1/files", storageRoutes);
  app.route("/api/v1/me/clubs", myClubRoutes);
  app.route("/api/v1/me/passes", myPassRoutes);
  app.route("/api/v1/me/registrations", myRegistrationRoutes);
  app.route("/api/v1/me/complaints", myComplaintRoutes);
  app.route("/api/v1/me/dashboard", dashboardRoutes);
  app.route("/api/v1/me/announcements", myAnnouncementRoutes);
  app.route("/api/v1/me/devices", myDeviceRoutes);
  app.route("/api/v1/me", meRoutes);
  app.route("/api/v1/faculty", facultyRoutes);
  app.route("/api/v1/admin", adminRoutes);
  app.route("/api/v1/departments", departmentRoutes);
  app.route("/api/v1/clubs", clubRoutes);
  app.route("/api/v1/clubs", clubEventRoutes);
  app.route("/api/v1/events", eventRoutes);
  app.route("/api/v1/approvals", approvalRoutes);
  app.route("/api/v1/approval-requests", approvalRequestRoutes);
  app.route("/api/v1/resources", resourceRoutes);
  app.route("/api/v1/resource-units", resourceUnitRoutes);
  app.route("/api/v1/me/events", myEventRoutes);
  // Event-scoped access configuration and the complaint inbox.
  app.route("/api/v1/events", eventRegistrationRoutes);
  app.route("/api/v1/events", eventAccessRoutes);
  app.route("/api/v1/events", eventComplaintRoutes);
  app.route("/api/v1/events", eventQuizRoutes);
  app.route("/api/v1/events", eventAnnouncementRoutes);
  app.route("/api/v1/events", eventRosterRoutes);
  app.route("/api/v1/quizzes", quizRoutes);
  app.route("/api/v1/announcements", announcementRoutes);
  app.route("/api/v1/access", accessRoutes);
  app.route("/api/v1/complaints", complaintRoutes);
  app.route("/api/v1/search", searchRoutes);
  app.notFound((c) => {
    throw new ApiError("NOT_FOUND", "Route not found.");
  });
  return app;
}
