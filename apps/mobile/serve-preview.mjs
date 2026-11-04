/** Static Expo web export + same-origin API proxy for the browser review preview.
 * Not a production server; native apps call EXPO_PUBLIC_API_URL directly. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
const root = join(import.meta.dir, "dist");
const api = process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.API_PORT ?? "8787"}`;
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};
Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 8081),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/health/")) {
      const headers = new Headers(req.headers);
      headers.set("host", new URL(api).host);
      try {
        return await fetch(`${api}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          duplex: "half",
        });
      } catch {
        return Response.json(
          {
            error: {
              code: "API_UNAVAILABLE",
              message: "Start the CampusOps API to use this preview.",
            },
          },
          { status: 502 },
        );
      }
    }
    let file = join(root, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(root)) return new Response("Not found", { status: 404 });
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html");
    return new Response(readFileSync(file), {
      headers: {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  },
});
console.log("Mobile review preview on :8081");
