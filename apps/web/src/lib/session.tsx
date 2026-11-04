import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, refreshSession, setAccessToken, setSessionLostHandler } from "./api";

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  status: string;
  accountType: string;
};

export type RoleAssignment = {
  id: string;
  role: string;
  scopeType: string;
  departmentId: string | null;
};

export type Membership = {
  clubId: string;
  clubName: string;
  clubRole: string;
  isActive: boolean;
};

export type Me = {
  user: SessionUser;
  globalRoles: RoleAssignment[];
  clubMemberships: Membership[];
};

type SessionValue = {
  me: Me | null;
  loading: boolean;
  roles: string[];
  isAdmin: boolean;
  isSenior: boolean;
  isFaculty: boolean;
  /** Any active club membership (lead, coordinator or club faculty): read access to club events. */
  isClubMember: boolean;
  /** May create/manage events: lead or coordinator (club faculty are read-only). */
  isCoordinator: boolean;
  isStaff: boolean;
  /** Department ids this user has authority over via a department-scoped role. */
  scopedDepartmentIds: string[];
  signIn: (token: string) => Promise<Me>;
  signOut: (everywhere?: boolean) => Promise<void>;
  reload: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const data = await api<Me>("/me");
    setMe(data);
    return data;
  }, []);

  useEffect(() => {
    setSessionLostHandler(() => setMe(null));
    (async () => {
      // A valid refresh cookie restores the session after a reload.
      const token = await refreshSession();
      if (token) {
        try {
          await loadMe();
        } catch {
          setAccessToken(null);
        }
      }
      setLoading(false);
    })();
    return () => setSessionLostHandler(null);
  }, [loadMe]);

  const signIn = useCallback(
    async (token: string) => {
      setAccessToken(token);
      return loadMe();
    },
    [loadMe],
  );

  const signOut = useCallback(async (everywhere = false) => {
    try {
      await api(everywhere ? "/auth/logout-all" : "/auth/logout", {});
    } catch {
      // Local sign-out still succeeds if the server session is already gone.
    }
    setAccessToken(null);
    setMe(null);
  }, []);

  const value = useMemo<SessionValue>(() => {
    const roles = (me?.globalRoles ?? []).map((r) => r.role);
    const has = (r: string) => roles.includes(r);
    return {
      me,
      loading,
      roles,
      isAdmin: has("ADMIN"),
      isSenior: has("HOD_DEAN"),
      isFaculty: has("FACULTY"),
      isClubMember: (me?.clubMemberships ?? []).some((m) => m.isActive),
      isCoordinator: (me?.clubMemberships ?? []).some(
        (m) => m.isActive && (m.clubRole === "LEAD" || m.clubRole === "COORDINATOR"),
      ),
      isStaff: roles.length > 0,
      scopedDepartmentIds: (me?.globalRoles ?? [])
        .filter((r) => r.scopeType === "DEPARTMENT" && r.departmentId)
        .map((r) => r.departmentId as string),
      signIn,
      signOut,
      reload: async () => {
        await loadMe();
      },
    };
  }, [me, loading, signIn, signOut, loadMe]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
