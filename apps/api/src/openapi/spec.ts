import { type Operation, jsonSchema, operations, toOpenApiPath } from "./manifest";

const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "ACCOUNT_PENDING",
  "ACCOUNT_SUSPENDED",
  "ACCOUNT_REJECTED",
  "EMAIL_NOT_VERIFIED",
  "INVALID_CREDENTIALS",
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "OTP_INVALID",
  "OTP_ATTEMPTS_EXCEEDED",
  "RATE_LIMITED",
  "LAST_ADMIN",
  "STORAGE_DISABLED",
  "FILE_TOO_LARGE",
  "FILE_TYPE_NOT_ALLOWED",
  "UPLOAD_INCOMPLETE",
  "RESOURCE_CONFLICT",
  "STALE_APPROVAL_VERSION",
  "APPROVAL_REQUIRED",
  "EVENT_WINDOW_INVALID",
  "INVALID_STATE_TRANSITION",
  "NOT_ELIGIBLE",
  "EVENT_NOT_OPEN",
  "HOLD_EXPIRED",
  "APPROVER_UNAVAILABLE",
  "QUIZ_REQUIRED",
  "QUIZ_MODE_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "DATABASE_UNAVAILABLE",
  "DATABASE_SCHEMA_OUT_OF_DATE",
  "INTERNAL_ERROR",
];

function pathParameters(path: string) {
  const names = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] as string);
  return names.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  }));
}

function queryParameters(op: Operation) {
  if (!op.query) return [];
  const schema = jsonSchema(op.query) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, def]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: def,
  }));
}

function operationObject(op: Operation) {
  const status = String(op.successStatus ?? 200);
  const headers: Record<string, unknown> = {};
  const parameters: unknown[] = [...pathParameters(toOpenApiPath(op.path)), ...queryParameters(op)];
  if (op.idempotent) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description:
        "Replays the original response for the same key and payload. A different payload with the same key returns 409 IDEMPOTENCY_CONFLICT.",
      schema: { type: "string", minLength: 8, maxLength: 200 },
    });
  }
  const notes: string[] = [];
  if (op.description) notes.push(op.description);
  if (op.roles?.length) notes.push(`Required role: ${op.roles.join(" or ")}.`);
  if (op.rateLimited) notes.push(`Rate limit: ${op.rateLimited}.`);

  return {
    tags: [op.tag],
    summary: op.summary,
    ...(notes.length ? { description: notes.join("\n\n") } : {}),
    operationId: `${op.method}_${op.path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
    security: op.auth ? [{ bearerAuth: [] }] : [],
    parameters,
    ...(op.body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchema(op.body) } },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: "Success",
        headers,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["data"],
              properties: { data: { type: "object", additionalProperties: true } },
            },
          },
        },
      },
      ...(op.auth ? { "401": { $ref: "#/components/responses/Unauthenticated" } } : {}),
      "400": { $ref: "#/components/responses/ValidationError" },
      "409": { $ref: "#/components/responses/Conflict" },
      "422": { $ref: "#/components/responses/Unprocessable" },
      "429": { $ref: "#/components/responses/RateLimited" },
    },
  };
}

export function buildOpenApiSpec() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const key = toOpenApiPath(op.path);
    paths[key] ??= {};
    (paths[key] as Record<string, unknown>)[op.method] = operationObject(op);
  }
  const errorResponse = (description: string) => ({
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ApiError" },
      },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "CampusOps API",
      version: "0.7.0",
      description:
        "Campus event operations API. Phase 5: accounts and verification, private file storage, " +
        "event lifecycle, individual approvals with explicit escalation, and conflict-free resource booking, coordinator-defined access QRs, location complaints and participant registration.\n\n" +
        "Conventions: every success response is `{ data: ... }`; every failure is `{ error: { code, message, details?, requestId? } }`. " +
        "List endpoints use `limit`/`offset` and return `hasMore`. Approval mutations require `expectedVersion`; " +
        "event lifecycle mutations require `expectedRevision`.",
    },
    servers: [{ url: "/api/v1", description: "Same-origin API base path" }],
    tags: [
      { name: "Meta", description: "Health and public configuration" },
      { name: "Auth", description: "Custom CampusOps authentication" },
      { name: "Files", description: "Private S3-backed uploads" },
      { name: "Admin", description: "Principal-level institutional authority" },
      {
        name: "Faculty",
        description: "Student verification, the only path to a verified college account",
      },
      { name: "Clubs", description: "Clubs and club-scoped coordinator roles" },
      { name: "Events", description: "Draft, revision, submit, publish, cancel" },
      { name: "Approvals", description: "One approval per permission, never merged" },
      { name: "Resources", description: "Catalog, units, availability and holds" },
      { name: "Audit", description: "Append-only, redacted history" },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        ApiError: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: ERROR_CODES },
                message: { type: "string" },
                details: { type: "object", additionalProperties: true },
                requestId: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        ValidationError: errorResponse("Validation failed (VALIDATION_ERROR)."),
        Unauthenticated: errorResponse("Missing, invalid or expired credentials."),
        Conflict: errorResponse(
          "State conflict, including RESOURCE_CONFLICT, STALE_APPROVAL_VERSION, INVALID_STATE_TRANSITION and IDEMPOTENCY_CONFLICT.",
        ),
        Unprocessable: errorResponse(
          "Business rule not satisfied, including APPROVAL_REQUIRED, NOT_ELIGIBLE and EVENT_WINDOW_INVALID.",
        ),
        RateLimited: errorResponse("Too many requests (RATE_LIMITED)."),
      },
    },
  };
}
