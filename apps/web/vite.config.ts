import { connect } from "node:net";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEFAULT_API_PORT = 8787;

function configuredPorts() {
  const values = [process.env.API_PORT, process.env.PORT, String(DEFAULT_API_PORT), "8087"];
  return [...new Set(values.filter((v): v is string => Boolean(v)).map(Number))].filter(
    (port) => Number.isInteger(port) && port > 0,
  );
}

function portIsOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(350, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

// The API and the web dev server are separate processes. Picking the wrong port
// turns every request into a proxy 500, so probe the configured ports at startup
// and tell the developer exactly what was found.
let apiTarget = `http://127.0.0.1:${configuredPorts()[0]}`;
let probing = false;

async function refreshApiTarget() {
  if (probing) return;
  probing = true;
  try {
    for (const port of configuredPorts()) {
      if (await portIsOpen(port)) {
        apiTarget = `http://127.0.0.1:${port}`;
        return;
      }
    }
  } finally {
    probing = false;
  }
}

function apiPortProbe() {
  return {
    name: "campusops-api-port-probe",
    async configureServer(server: {
      config: { logger: { info: (msg: string) => void; warn: (msg: string) => void } };
    }) {
      for (const port of configuredPorts()) {
        if (await portIsOpen(port)) {
          apiTarget = `http://127.0.0.1:${port}`;
          server.config.logger.info(`[campusops] API proxy → ${apiTarget}`);
          return;
        }
      }
      server.config.logger.warn(
        `[campusops] No API found on ${configuredPorts()
          .map((p) => `:${p}`)
          .join(
            ", ",
          )}. Start it with "bun run dev:api", or set API_PORT in .env.local to match the API.`,
      );
    },
  };
}

export default defineConfig(({ command }) => {
  // A production build must not inherit NODE_ENV=development from a sourced
  // .env file or the CI environment. When it does, Vite keeps React's development
  // build AND the JSX dev runtime, and the bundle more than doubles (356 kB vs
  // 161 kB here) while still reporting a successful build. Set it here, before
  // the plugins read it, so the output depends on the command alone.
  if (command === "build") process.env.NODE_ENV = "production";
  return {
    plugins: [react(), apiPortProbe()],
    ...(command === "build"
      ? { define: { "process.env.NODE_ENV": JSON.stringify("production") } }
      : {}),
    server: {
      host: "0.0.0.0",
      port: 5173,
      allowedHosts: true,
      proxy: {
        "/api": {
          target: apiTarget,
          router: () => apiTarget,
          changeOrigin: true,
          configure: (proxy: {
            on: (event: "error", handler: (err: Error, req: unknown, res: unknown) => void) => void;
          }) => {
            proxy.on("error", (err, _req, res) => {
              // The API may have started after Vite, or moved port on restart.
              // Probe again so the next request finds it instead of staying stuck.
              void refreshApiTarget();
              const response = res as
                | {
                    headersSent?: boolean;
                    writeHead?: (status: number, headers: Record<string, string>) => void;
                    end?: (body: string) => void;
                  }
                | null
                | undefined;
              if (response && !response.headersSent && response.writeHead && response.end) {
                response.writeHead(502, { "Content-Type": "application/json" });
                response.end(
                  JSON.stringify({
                    error: {
                      code: "API_UNAVAILABLE",
                      message: `The API is not reachable at ${apiTarget}. Start it with "bun run dev:api", then reload; the proxy re-checks the configured ports automatically.`,
                    },
                  }),
                );
                return;
              }
              console.error(`[campusops] API proxy error: ${err.message}`);
            });
          },
        },
      },
    },
  };
});
