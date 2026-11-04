import type { Context } from "hono";
import { authenticate, requireActiveAccount } from "../../middleware/auth";
import { requireEventOperationalRead } from "../../middleware/event-scope";
import { rateLimit } from "../../middleware/rate-limit";
import { parseJson, parseQuery } from "../../middleware/validate";
import { ok } from "../../utils/response";
import { auditContext } from "../audit/service";
import * as schemas from "./schemas";
import * as service from "./service";

/**
 * Event report handlers. Registered on `eventRoutes` (not mounted as a router at
 * /api/v1) so the wildcard auth middleware cannot leak onto unrelated paths.
 *
 * Access is institutional: the coordinators who ran the event, faculty who were
 * involved in its approvals, the club's faculty members, HOD/Dean within the
 * department, and Admin. Enforced in `assertReportAccess`.
 */

export async function generateReportHandler(c: Context) {
  const input = await parseJson(c, schemas.generateReportSchema);
  const result = await service.generateReport(
    c.get("auth"),
    c.req.param("id") as string,
    input,
    auditContext(c),
  );
  return ok(
    c,
    {
      report: {
        id: result.report.id,
        sequence: result.report.sequence,
        eventRevision: result.report.eventRevision,
        generatedAt: result.report.createdAt,
        checksum: result.report.checksumSha256,
        archivedFileId: result.report.fileId,
      },
      snapshot: result.snapshot,
      archived: result.archived,
      downloadPath: `/api/v1/events/${c.req.param("id")}/reports/${result.report.id}/pdf`,
      ...(result.archived
        ? {}
        : {
            archiveNote:
              "Object storage is disabled, so the PDF was not archived. It is re-rendered from the stored snapshot on download.",
          }),
    },
    201,
  );
}

export async function previewReportHandler(c: Context) {
  const { notes } = parseQuery(c, schemas.reportPreviewQuerySchema);
  const snapshot = await service.buildSnapshot(c.get("auth"), c.req.param("id") as string, notes);
  return ok(c, { snapshot, checksum: service.checksumOf(snapshot), preview: true });
}

export async function listReportsHandler(c: Context) {
  return ok(c, await service.listReports(c.get("auth"), c.req.param("id") as string));
}

export async function getReportHandler(c: Context) {
  const result = await service.getReport(
    c.get("auth"),
    c.req.param("id") as string,
    c.req.param("reportId") as string,
  );
  return ok(c, result);
}

/** Streams the PDF inline so a browser can open or save it directly. */
export async function downloadReportHandler(c: Context) {
  const { bytes, snapshot, report } = await service.renderStoredReport(
    c.get("auth"),
    c.req.param("id") as string,
    c.req.param("reportId") as string,
  );
  const filename = `${snapshot.event.slug}-report-${report.sequence}.pdf`;
  // Copy into a standalone ArrayBuffer: pdf-lib returns a view over a larger buffer.
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
      "x-report-checksum": report.checksumSha256,
    },
  });
}

export const reportRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  prefix: "event-report",
});

export { authenticate, requireActiveAccount, requireEventOperationalRead };
