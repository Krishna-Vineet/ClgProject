import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq } from "drizzle-orm";
import { env, storageConfig } from "../../config/env";
import { getDb } from "../../db/client";
import { files, staffProfiles, studentProfiles } from "../../db/schema";
import { ApiError } from "../../utils/api-error";
import { type AuditContext, insertAudit } from "../audit/service";

export type FilePurpose =
  | "PROFILE_PHOTO"
  | "COLLEGE_ID_PROOF"
  | "EVENT_BANNER"
  | "EVENT_REPORT"
  | "ATTENDEE_EXPORT"
  | "COMPLAINT_ATTACHMENT";

const ALLOWED: Record<FilePurpose, string[]> = {
  PROFILE_PHOTO: ["image/jpeg", "image/png", "image/webp"],
  COLLEGE_ID_PROOF: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  EVENT_BANNER: ["image/jpeg", "image/png", "image/webp"],
  EVENT_REPORT: ["application/pdf"],
  ATTENDEE_EXPORT: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
  ],
  COMPLAINT_ATTACHMENT: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
};

function s3() {
  const cfg = storageConfig();
  if (!cfg)
    throw new ApiError(
      "STORAGE_DISABLED",
      "Private storage is not enabled. Set STORAGE_MODE=s3 and the S3 environment group.",
    );
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,
  });
  return { cfg, client };
}

export async function presignUpload(
  ownerId: string,
  input: { purpose: FilePurpose; mimeType: string; sizeBytes: number },
  audit?: AuditContext,
) {
  const { cfg, client } = s3();
  if (!ALLOWED[input.purpose]?.includes(input.mimeType))
    throw new ApiError("VALIDATION_ERROR", "Unsupported file type for this purpose.");
  if (input.sizeBytes <= 0 || input.sizeBytes > cfg.uploadMaxBytes)
    throw new ApiError("VALIDATION_ERROR", "File size is outside the allowed range.");
  const { db } = getDb();
  const id = randomUUID();
  const objectKey = `private/${ownerId}/${input.purpose.toLowerCase()}/${id}`;
  await db.transaction(async (tx) => {
    await tx.insert(files).values({
      id,
      ownerId,
      purpose: input.purpose,
      objectKey,
      bucket: cfg.bucket,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      status: "PENDING",
    });
    if (audit)
      await insertAudit(tx, audit, {
        action: "FILE_UPLOAD_PRESIGNED",
        entityType: "file",
        entityId: id,
        after: { purpose: input.purpose, mimeType: input.mimeType, sizeBytes: input.sizeBytes },
      });
  });
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: cfg.bucket, Key: objectKey, ContentType: input.mimeType }),
    { expiresIn: cfg.signedUrlTtlSeconds },
  );
  return {
    fileId: id,
    objectKey,
    uploadUrl,
    expiresIn: cfg.signedUrlTtlSeconds,
    headers: { "Content-Type": input.mimeType },
  };
}

export async function completeUpload(ownerId: string, fileId: string, audit?: AuditContext) {
  const { cfg, client } = s3();
  const { db } = getDb();
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.ownerId, ownerId)))
    .limit(1);
  if (!file) throw new ApiError("NOT_FOUND", "File not found.");
  if (file.status === "READY") return file;
  const head = await client.send(
    new HeadObjectCommand({ Bucket: cfg.bucket, Key: file.objectKey }),
  );
  const size = Number(head.ContentLength ?? 0);
  if (size <= 0 || size > cfg.uploadMaxBytes || size !== file.sizeBytes)
    throw new ApiError("VALIDATION_ERROR", "Uploaded object size does not match the request.");
  if (head.ContentType && head.ContentType !== file.mimeType)
    throw new ApiError("VALIDATION_ERROR", "Uploaded object type does not match the request.");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(files)
      .set({
        status: "READY",
        completedAt: new Date(),
        checksumSha256: head.ETag?.replaceAll('"', "") ?? null,
      })
      .where(eq(files.id, fileId))
      .returning();
    if (file.purpose === "PROFILE_PHOTO") {
      await tx
        .update(studentProfiles)
        .set({ photoFileId: fileId, updatedAt: new Date() })
        .where(eq(studentProfiles.userId, ownerId));
      await tx
        .update(staffProfiles)
        .set({ photoFileId: fileId, updatedAt: new Date() })
        .where(eq(staffProfiles.userId, ownerId));
    }
    if (file.purpose === "COLLEGE_ID_PROOF") {
      await tx
        .update(studentProfiles)
        .set({ idProofFileId: fileId, updatedAt: new Date() })
        .where(eq(studentProfiles.userId, ownerId));
    }
    if (audit)
      await insertAudit(tx, audit, {
        action: "FILE_UPLOAD_COMPLETED",
        entityType: "file",
        entityId: fileId,
        after: { status: updated?.status, purpose: file.purpose },
      });
    return updated;
  });
}

export async function signedDownload(fileId: string) {
  const { cfg, client } = s3();
  const { db } = getDb();
  const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  if (!file || file.status !== "READY") throw new ApiError("NOT_FOUND", "File not found.");
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: file.bucket ?? cfg.bucket, Key: file.objectKey }),
    { expiresIn: cfg.signedUrlTtlSeconds },
  );
  return {
    fileId: file.id,
    purpose: file.purpose,
    mimeType: file.mimeType,
    url,
    expiresIn: cfg.signedUrlTtlSeconds,
  };
}

export async function getOwnedFile(ownerId: string, fileId: string) {
  const { db } = getDb();
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.ownerId, ownerId)))
    .limit(1);
  if (!file) throw new ApiError("NOT_FOUND", "File not found.");
  return file;
}

export function storagePublicConfig() {
  return { mode: env.STORAGE_MODE, maxBytes: env.UPLOAD_MAX_BYTES, allowed: ALLOWED };
}

/** Reports can be archived only when real object storage is configured. */
export function canArchiveReports(): boolean {
  return storageConfig() !== null;
}

/**
 * Upload generated report bytes to object storage. This performs network I/O
 * only: the caller inserts the `files` row inside its own transaction, so a
 * rolled-back report can never leave an orphaned database record.
 */
export async function putReportObject(eventId: string, bytes: Uint8Array, filename: string) {
  const { cfg, client } = s3();
  const id = randomUUID();
  const objectKey = `private/events/${eventId}/reports/${id}/${filename}`;
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: "application/pdf",
      ContentLength: bytes.byteLength,
    }),
  );
  return {
    id,
    objectKey,
    bucket: cfg.bucket,
    sizeBytes: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Best-effort cleanup when the surrounding transaction fails. */
export async function deleteReportObject(objectKey: string, bucket: string) {
  try {
    const { client } = s3();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch {
    // Leaving an unreferenced object is acceptable; failing the request is not.
  }
}
