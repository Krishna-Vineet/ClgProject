import { Hono } from "hono";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import { ok } from "../../utils/response";
import { dashboard } from "./service";

export const dashboardRoutes = new Hono();
dashboardRoutes.use("*", authenticate, requireActiveAccount);
dashboardRoutes.get("/", async (c) => ok(c, await dashboard(c.get("auth"))));
