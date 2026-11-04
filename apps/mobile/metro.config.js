const { getDefaultConfig } = require("expo/metro-config");
const http = require("node:http");
const https = require("node:https");

const config = getDefaultConfig(__dirname);
const target = new URL(process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8787");
const transport = target.protocol === "https:" ? https : http;

// The browser preview uses relative /api URLs. Metro forwards them server-side;
// browser code never calls localhost. Native builds use EXPO_PUBLIC_API_URL.
config.server.enhanceMiddleware = (middleware) => (req, res, next) => {
  if (req.url?.startsWith("/api/") || req.url?.startsWith("/health/")) {
    const proxy = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxy.on("error", () => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "API_UNAVAILABLE",
            message: "API is not reachable. Start the CampusOps API.",
          },
        }),
      );
    });
    req.pipe(proxy);
    return;
  }
  return middleware(req, res, next);
};

module.exports = config;
