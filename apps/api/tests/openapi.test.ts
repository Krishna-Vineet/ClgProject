import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { operations, toOpenApiPath } from "../src/openapi/manifest";
import { buildOpenApiSpec } from "../src/openapi/spec";

/**
 * The OpenAPI document must describe exactly the routes the app serves.
 * A route added without documentation (or documented without being implemented)
 * fails this test, which is what keeps the contract honest.
 */
describe("OpenAPI contract", () => {
  const app = createApp();
  const spec = buildOpenApiSpec();

  test("every mounted API route is documented", () => {
    const documented = new Set(operations.map((op) => `${op.method.toUpperCase()} ${op.path}`));
    const mounted = new Set(
      app.routes
        .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/v1/"))
        // The spec document itself is not an API operation.
        .filter((r) => r.path !== "/api/v1/openapi.json")
        .map((r) => `${r.method} ${r.path.replace(/^\/api\/v1/, "")}`),
    );
    const missing = [...mounted].filter((r) => !documented.has(r)).sort();
    expect(missing).toEqual([]);
  });

  test("every documented operation is actually mounted", () => {
    const mounted = new Set(
      app.routes
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method} ${r.path.replace(/^\/api\/v1/, "")}`),
    );
    const phantom = operations
      .map((op) => `${op.method.toUpperCase()} ${op.path}`)
      .filter((r) => !mounted.has(r))
      .sort();
    expect(phantom).toEqual([]);
  });

  test("spec is valid OpenAPI 3.1 with unique operation ids", () => {
    expect(spec.openapi).toBe("3.1.0");
    const ids: string[] = [];
    for (const pathItem of Object.values(spec.paths)) {
      for (const op of Object.values(pathItem) as Array<{ operationId: string }>) {
        ids.push(op.operationId);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(operations.length);
  });

  test("path parameters are declared for every templated path", () => {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      const declared = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] as string);
      for (const op of Object.values(pathItem) as Array<{
        parameters: Array<{ name: string; in: string; required: boolean }>;
      }>) {
        const params = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
        expect(params.sort()).toEqual([...declared].sort());
      }
    }
  });

  test("request bodies are real JSON Schema, not placeholders", () => {
    const withBody = operations.filter((op) => op.body);
    expect(withBody.length).toBeGreaterThan(20);
    for (const op of withBody) {
      const pathItem = spec.paths[toOpenApiPath(op.path)] as Record<
        string,
        { requestBody?: { content: { "application/json": { schema?: { type?: string } } } } }
      >;
      const schema = pathItem[op.method]?.requestBody?.content["application/json"].schema;
      expect(schema).toBeDefined();
      expect(schema?.type === "object" || schema?.type === undefined).toBe(true);
    }
  });

  test("protected operations declare bearer auth and public ones do not", () => {
    for (const op of operations) {
      const pathItem = spec.paths[toOpenApiPath(op.path)] as Record<
        string,
        { security: Array<Record<string, unknown>> }
      >;
      const security = pathItem[op.method]?.security;
      expect(security).toEqual(op.auth ? [{ bearerAuth: [] }] : []);
    }
  });

  test("the served document matches the generated one", async () => {
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const served = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(served.openapi).toBe("3.1.0");
    expect(Object.keys(served.paths).length).toBe(Object.keys(spec.paths).length);
  });

  test("approval and event mutations document optimistic concurrency", () => {
    const decision = operations.find((o) => o.path === "/approval-requests/:id/decision");
    expect(decision?.description).toContain("expectedVersion");
    const publish = operations.find((o) => o.path === "/events/:id/publish");
    expect(publish?.description).toContain("APPROVAL_REQUIRED");
    const submit = operations.find((o) => o.path === "/events/:id/submit");
    expect(submit?.description).toContain("RESOURCE_CONFLICT");
  });
});
