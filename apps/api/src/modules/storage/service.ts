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

/**
 * Identify a file by its leading bytes.
 *
 * The upload path used to trust the client twice: the presigned URL pinned the
 * `Content-Type` the client asked for, and `complete` compared the object's
 * content type against that same client-supplied value. An attacker could upload
 * HTML and call it `image/png`, and both checks agreed with each other. Sniffing
 * the first bytes is the only check that does not believe the client.
 */
const SIGNATURES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP
  { mime: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/** Returns the sniffed MIME type, or null when the bytes match no allowed type. */
export function sniffMimeType(prefix: Uint8Array): string | null {
  for (const signature of SIGNATURES) {
    const start = signature.offset ?? 0;
    if (prefix.length < start + signature.bytes.length) continue;
    const matches = signature.bytes.every((byte, index) => prefix[start + index] === byte);
    if (matches) return signature.mime;
  }
  return null;
}

/**
 * Read the first bytes of an upload and compare them with what it claims to be.
 * Office documents are zip containers and cannot be told apart by magic bytes, so
 * they are accepted on their declared type (sheets are only ever downloaded by
 * their owner, never served inline).
 */
async function assertContentMatches(
  client: S3Client,
  bucket: string,
  key: string,
  declared: string,
) {
  if (declared.startsWith("application/vnd.openxmlformats") || declared === "text/csv") return;
  const head = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: "bytes=0-15" }),
  );
  const body = head.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  const bytes = body?.transformToByteArray ? await body.transformToByteArray() : null;
  if (!bytes) throw new ApiError("VALIDATION_ERROR", "The uploaded object could not be verified.");
  const sniffed = sniffMimeType(bytes);
  if (sniffed !== declared)
    throw new ApiError(
      "VALIDATION_ERROR",
      `The uploaded file is not a ${declared} document. Its contents do not match the file type you selected.`,
    );
}

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
  // The header above is what the client asked for. Verify the bytes too.
  await assertContentMatches(client, cfg.bucket, file.objectKey, file.mimeType);
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
