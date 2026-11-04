import * as shared from "@campusops/shared";
import { Hono } from "hono";
import { authenticate, requireActiveAccount, requireRole } from "../../middleware/auth";
import { requireClubManage, requireClubRead } from "../../middleware/club-scope";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

// Shared offset pagination: the same schema the OpenAPI document advertises.
const pageSchema = shared.offsetPaginationSchema;

export const clubRoutes = new Hono();
clubRoutes.use("*", authenticate, requireActiveAccount);

clubRoutes.get("/", async (c) =>
  ok(c, await service.listClubs(c.get("auth"), parseQuery(c, pageSchema))),
);
clubRoutes.post("/", requireRole("ADMIN"), async (c) => {
  const input = await parseJson(c, schemas.createClubSchema);
  const row = await service.createClub(c.get("auth").user.id, input, auditContext(c));
  return ok(c, row, 201);
});

export const myClubRoutes = new Hono();
myClubRoutes.use("*", authenticate);
myClubRoutes.get("/", async (c) => ok(c, { items: await service.myClubs(c.get("auth")) }));

clubRoutes.get("/:id", requireClubRead(), async (c) => ok(c, c.get("club")));
clubRoutes.patch("/:id", requireClubManage(), async (c) => {
  const input = await parseJson(c, schemas.updateClubSchema);
  const row = await service.updateClub(c.req.param("id"), input, auditContext(c));
  return ok(c, row);
});

clubRoutes.get("/:id/candidates", requireClubManage(), async (c) =>
  ok(c, await service.findMemberCandidates(parseQuery(c, schemas.candidateQuerySchema))),
);

clubRoutes.get("/:id/members", requireClubRead(), async (c) =>
  ok(c, {
    items: await service.listMembers(c.req.param("id")),
    canManage: service.canManageClub(c.get("auth"), c.get("club")),
  }),
);
clubRoutes.post("/:id/members", requireClubManage(), async (c) => {
  const input = await parseJson(c, schemas.addMemberSchema);
  const row = await service.addMember(c.get("auth"), c.req.param("id"), input, auditContext(c));
  return ok(c, row, 201);
});
clubRoutes.patch("/:id/members/:membershipId", requireClubManage(), async (c) => {
  const input = await parseJson(c, schemas.updateMemberSchema);
  const row = await service.updateMember(
    c.get("auth"),
    c.req.param("id"),
    c.req.param("membershipId"),
    input,
    auditContext(c),
  );
  return ok(c, row);
});
clubRoutes.delete("/:id/members/:membershipId", requireClubManage(), async (c) => {
  const row = await service.removeMember(
    c.get("auth"),
    c.req.param("id"),
    c.req.param("membershipId"),
    auditContext(c),
  );
  return ok(c, row);
});
