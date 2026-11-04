import {
  type PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Platform } from "react-native";
import { Loading, Screen } from "../components/ui";
import {
  API_ORIGIN,
  type AuthPayload,
  adoptSession,
  api,
  clearSession,
  onSessionLost,
  restoreSession,
} from "./api";
import type { Config, Me } from "./types";

type Session = {
  me: Me | null;
  config: Config | null;
  ready: boolean;
  bootError: string | null;
  signIn: (p: AuthPayload) => Promise<void>;
  signOut: () => Promise<void>;
  reloadMe: () => Promise<void>;
  retryBoot: () => void;
};
const Context = createContext<Session | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reloadMe = useCallback(async () => {
    setMe(await api<Me>("/me"));
  }, []);
  const signIn = useCallback(
    async (p: AuthPayload) => {
      await adoptSession(p);
      await reloadMe();
    },
    [reloadMe],
  );
  const signOut = useCallback(async () => {
    try {
      await api("/auth/logout", {});
    } catch {
      /* local sign-out still clears the device */
    }
    await clearSession();
    setMe(null);
  }, []);
  useEffect(() => {
    let alive = true;
    setReady(false);
    setBootError(null);
    void attempt; // explicit retry trigger; changing it reruns this boot effect.
    (async () => {
      try {
        if (Platform.OS !== "web" && !API_ORIGIN)
          throw new Error(
            "Set EXPO_PUBLIC_API_URL to the API origin before building the native app.",
          );
        const cfg = await api<Config>("/config");
        if (!alive) return;
        setConfig(cfg);
        const restored = await restoreSession();
        if (restored) {
          const profile = await api<Me>("/me");
          if (alive) setMe(profile);
        }
      } catch (err) {
        if (alive)
          setBootError(err instanceof Error ? err.message : "Could not load configuration.");
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);
  useEffect(() => {
    onSessionLost(() => setMe(null));
    return () => onSessionLost(null);
  }, []);
  if (!ready)
    return (
      <Screen>
        <Loading label="Connecting to CampusOps…" />
      </Screen>
    );
  return (
    <Context.Provider
      value={{
        me,
        config,
        ready,
        bootError,
        signIn,
        signOut,
        reloadMe,
        retryBoot: () => setAttempt((n) => n + 1),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider missing");
  return value;
}
