import { createMiddleware } from "hono/factory";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export const requestId = createMiddleware(async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && incoming.length <= 100 ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
});
