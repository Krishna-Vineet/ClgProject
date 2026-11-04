import type { Context } from "hono";
import { authConfig } from "../../config/env";
import { getDb } from "../../db/client";
import { auditLogs } from "../../db/schema";
import { redact } from "../../utils/redact";
import { hashIp } from "../../utils/tokens";

export type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string | null | undefined;
  clubId?: string | null | undefined;
  eventId?: string | null | undefined;
  before?: unknown;
  after?: unknown;
};

export type AuditContext = {
  actorId: string | null;
  requestId: string | null;
  ipHash: string | null;
};

export function auditContext(c: Context): AuditContext {
  const auth = c.get("auth");
  const cfg = authConfig();
  const trust = process.env.TRUST_PROXY_HEADERS === "true";
  const ip = trust
    ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      undefined)
    : undefined;
  return {
    actorId: auth?.user.id ?? null,
    requestId: c.get("requestId") ?? null,
    ipHash: hashIp(ip, cfg.refreshPepper),
  };
}

type AuditExecutor = Pick<ReturnType<typeof getDb>["db"], "insert">;

export async function insertAudit(executor: AuditExecutor, ctx: AuditContext, input: AuditInput) {
  await executor.insert(auditLogs).values({
    actorId: ctx.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    clubId: input.clubId ?? null,
    eventId: input.eventId ?? null,
    beforeData:
      input.before === undefined ? null : (redact(input.before) as Record<string, unknown>),
    afterData: input.after === undefined ? null : (redact(input.after) as Record<string, unknown>),
    requestId: ctx.requestId,
    ipHash: ctx.ipHash,
  });
}

/** Convenience for non-transactional/read audits. Critical mutations should use insertAudit inside their transaction. */
export async function writeAudit(c: Context, input: AuditInput) {
  const { db } = getDb();
  await insertAudit(db, auditContext(c), input);
}
