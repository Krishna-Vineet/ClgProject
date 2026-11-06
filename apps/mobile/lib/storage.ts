import { useEffect, useState } from "react";
import { api } from "./api";
import { useSession } from "./session";

/**
 * Whether the server can actually accept an upload, and why not when it cannot.
 *
 * Both profile screens used to decide this themselves from `config.storageMode`,
 * so they could only ever say "not configured". The server answers the real
 * question at `GET /files/config` — including the name of the variable that needs
 * setting — and this hook is the single place that asks it.
 */
export function useStorageAvailability() {
  const { config } = useSession();
  const [answer, setAnswer] = useState<{ enabled: boolean; reason: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ enabled: boolean; reason: string | null }>("/files/config")
      .then((r) => {
        if (alive) setAnswer({ enabled: r.enabled, reason: r.reason });
      })
      .catch(() => {
        // The probe can fail before the session is fully up; the boot config is a
        // reasonable stand-in, and it is retried whenever the mode changes.
        if (alive) setAnswer({ enabled: config?.storageMode === "s3", reason: null });
      });
    return () => {
      alive = false;
    };
  }, [config?.storageMode]);

  return {
    // Assume available until told otherwise: flashing "unavailable" at someone
    // whose storage is fine is worse than a disabled button for one frame.
    enabled: answer?.enabled ?? config?.storageMode === "s3",
    reason:
      answer?.reason ??
      (config?.storageMode === "s3"
        ? null
        : "Secure uploads are unavailable until the administrator enables private object storage."),
  };
}
