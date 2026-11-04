import * as shared from "@campusops/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db/client";
import { files } from "../../db/schema";
import { authenticate, requireRole } from "../../middleware/auth";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ApiError } from "../../utils/api-error";
import { ok } from "../../utils/response";
import { auditContext, writeAudit } from "../audit/service";
import { signedDownload } from "../storage/service";
import * as schemas from "./schemas";
import * as service from "./service";

// Shared offset pagination: the same schema the OpenAPI document advertises.
const pageSchema = shared.offsetPaginationSchema;

export const facultyRoutes = new Hono();
facultyRoutes.use("*", authenticate);

facultyRoutes.get("/verification-queue", requireRole("FACULTY", "HOD_DEAN"), async (c) =>
  ok(c, await service.listVerificationQueue(c.get("auth"), parseQuery(c, pageSchema))),
);
facultyRoutes.get("/students", requireRole("HOD_DEAN", "ADMIN"), async (c) =>
  ok(c, await service.listStudents(c.get("auth"), parseQuery(c, schemas.listStudentsSchema))),
);
facultyRoutes.get("/students/:id", requireRole("FACULTY", "HOD_DEAN"), async (c) =>
  ok(c, await service.getStudent(c.get("auth"), c.req.param("id"))),
);

facultyRoutes.post("/students/:id/verify", requireRole("FACULTY"), async (c) => {
  const input = await parseJson(c, schemas.verifySchema);
  const result = await service.verifyStudent(
    c.get("auth"),
    c.req.param("id"),
    auditContext(c),
    input.note,
  );
  return ok(c, result);
});

facultyRoutes.post("/students/:id/reject", requireRole("FACULTY"), async (c) => {
  const input = await parseJson(c, schemas.rejectSchema);
  const result = await service.rejectStudent(
    c.get("auth"),
    c.req.param("id"),
    input,
    auditContext(c),
  );
  return ok(c, result);
});

facultyRoutes.patch(
  "/students/:id/profile",
  requireRole("FACULTY", "HOD_DEAN", "ADMIN"),
  async (c) => {
    const input = await parseJson(c, schemas.profilePatchSchema);
    const result = await service.patchStudentProfile(
      c.get("auth"),
      c.req.param("id"),
      input,
      auditContext(c),
    );
    return ok(c, result.after);
  },
);

facultyRoutes.get("/students/:id/files/:fileId/download", requireRole("FACULTY"), async (c) => {
  const student = await service.getStudent(c.get("auth"), c.req.param("id"));
  const { db } = getDb();
  const [file] = await db
    .select()
    .from(files)
    .where(eq(files.id, c.req.param("fileId")))
    .limit(1);
  if (!file || file.ownerId !== student.user.id) throw new ApiError("NOT_FOUND", "File not found.");
  const result = await signedDownload(file.id);
  await writeAudit(c, {
    action: "FACULTY_PROOF_DOWNLOADED",
    entityType: "file",
    entityId: file.id,
    after: { studentId: student.user.id, purpose: file.purpose },
  });
  return ok(c, result);
});
