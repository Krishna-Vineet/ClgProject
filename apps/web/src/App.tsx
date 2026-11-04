import {
  Component,
  type ReactNode,
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ToastProvider } from "./components/feedback";
import { Icon, Logo } from "./components/icons";
import { Card, Kbd, PanelSkeleton, formatDay } from "./components/ui";
import { AuthPanel } from "./features/AuthPanel";
import { type DashboardData, DashboardPanel } from "./features/DashboardPanel";
import { type Page, api, query } from "./lib/api";
import { SessionProvider, useSession } from "./lib/session";
import type { EventRow } from "./lib/types";

/**
 * Panels are split by role into separate chunks. A club coordinator never
 * downloads the administration screen, and hovering a nav item warms the chunk
 * before the click lands.
 */
const loaders = {
  account: () => import("./features/AccountPanel").then((m) => ({ default: m.AccountPanel })),
  admin: () => import("./features/AdminPanel").then((m) => ({ default: m.AdminPanel })),
  audit: () => import("./features/AuditPanel").then((m) => ({ default: m.AuditPanel })),
  approvals: () => import("./features/ApprovalsPanel").then((m) => ({ default: m.ApprovalsPanel })),
  clubs: () => import("./features/ClubsPanel").then((m) => ({ default: m.ClubsPanel })),
  events: () =>
    import("./features/CoordinatorPanel").then((m) => ({ default: m.CoordinatorPanel })),
  reports: () => import("./features/ReportsPanel").then((m) => ({ default: m.ReportsPanel })),
  resources: () => import("./features/ResourcesPanel").then((m) => ({ default: m.ResourcesPanel })),
  students: () => import("./features/StudentsPanel").then((m) => ({ default: m.StudentsPanel })),
  verification: () =>
    import("./features/VerificationPanel").then((m) => ({ default: m.VerificationPanel })),
};

// Memoised so a keystroke in the global search repaints the chrome, not the
// whole workspace underneath it.
const AccountPanel = memo(lazy(loaders.account));
const AdminPanel = memo(lazy(loaders.admin));
const AuditPanel = memo(lazy(loaders.audit));
const ApprovalsPanel = memo(lazy(loaders.approvals));
const ClubsPanel = memo(lazy(loaders.clubs));
const CoordinatorPanel = memo(lazy(loaders.events));
const ReportsPanel = memo(lazy(loaders.reports));
const ResourcesPanel = memo(lazy(loaders.resources));
const StudentsPanel = memo(lazy(loaders.students));
const VerificationPanel = memo(lazy(loaders.verification));

type Health = { status: string; phase: number; checks: { database: string } };
type Config = {
  demoMode: boolean;
  emailMode: string | null;
  exposeDemoOtp: boolean;
  storageMode: string;
  institutionName?: string;
};
type Tab =
  | "dashboard"
  | "events"
  | "approvals"
  | "verification"
  | "students"
  | "resources"
  | "clubs"
  | "reports"
  | "admin"
  | "audit"
  | "account";

const TAB_META: Record<
  Tab,
  { label: string; short: string; icon: string; group: "Workspace" | "Institution" | "You" }
> = {
  dashboard: { label: "Dashboard", short: "Overview", icon: "dashboard", group: "Workspace" },
  events: { label: "Events", short: "Events", icon: "calendar", group: "Workspace" },
  approvals: { label: "Approvals", short: "Approvals", icon: "inbox", group: "Workspace" },
  verification: {
    label: "Student verification",
    short: "Verification",
    icon: "shield",
    group: "Workspace",
  },
  students: { label: "Students", short: "Students", icon: "graduation", group: "Workspace" },
  resources: { label: "Resources", short: "Resources", icon: "box", group: "Institution" },
  clubs: { label: "Clubs", short: "Clubs", icon: "users", group: "Institution" },
  reports: { label: "Reports", short: "Reports", icon: "file", group: "Institution" },
  admin: { label: "Administration", short: "Admin", icon: "settings", group: "Institution" },
  audit: { label: "Audit trail", short: "Audit", icon: "clock", group: "Institution" },
  account: { label: "Account", short: "Account", icon: "user", group: "You" },
};
const SECTION_LEDE: Record<Tab, string> = {
  dashboard: "",
  events:
    "Draft an event, ask for each permission separately, publish when every required approval lands, then run the day and file the record.",
  approvals:
    "One decision per permission. Approve it, ask for a change, or send it up the chain. Every action is kept on the request's trail.",
  verification:
    "Check college IDs and keep student profiles accurate. Verification is limited to faculty and department heads.",
  students: "Every student account, their department and verification state in one directory.",
  resources: "Rooms, labs and equipment with holds the database refuses to double-book.",
  clubs:
    "Club structure, coordinators and club faculty. Faculty membership is owned by the HOD or Dean.",
  reports:
    "Immutable event records as PDF: the approval trail, resources used, attendance, and a checksum that can be re-verified.",
  admin: "Staff directory and departments. Positions describe the job; roles grant access.",
  audit: "An append-only record of who changed what, kept for institutional review.",
  account: "Your profile, roles, password and active sessions.",
};
const TABS = Object.keys(TAB_META) as Tab[];
const isTab = (v: string): v is Tab => (TABS as string[]).includes(v);
const tabFromHash = (): Tab | null => {
  const h = location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  return isTab(h) ? h : null;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function longDate(d: Date) {
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function shortDate(d: Date) {
  return `${d.getDate()} ${MONTHS[d.getMonth()]?.slice(0, 3)}`;
}

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SessionProvider>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("campusops-theme");
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("campusops-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#121210" : "#f3f0e8");
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")) };
}

type PaletteItem =
  | { kind: "event"; id: string; title: string; when: string; status: EventRow["status"] }
  | { kind: "club"; id: string; name: string; detail: string }
  | { kind: "person"; id: string; name: string; detail: string; role: string; roles: string[] }
  | { kind: "tab"; tab: Tab; label: string; icon: string; hint: string }
  | { kind: "action"; action: "new" | "theme" | "signout"; label: string; icon: string };

type SearchResults = {
  events: EventRow[];
  clubs: Array<{ id: string; name: string; slug: string; description: string | null }>;
  people: Array<{
    id: string;
    fullName: string;
    email: string;
    status: string;
    role: string;
    roles: string[];
  }>;
};

function Shell() {
  const session = useSession();
  const { me, loading, isClubMember, isStaff, isFaculty, isSenior, isAdmin, signIn, signOut } =
    session;
  const { theme, toggle } = useTheme();
  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [tab, setTab] = useState<Tab | null>(tabFromHash);
  const [drawer, setDrawer] = useState(false);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [focusEvent, setFocusEvent] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [online, setOnline] = useState(() => navigator.onLine);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchWrap = useRef<HTMLDivElement>(null);
  const toolWrap = useRef<HTMLDivElement>(null);
  const prefetched = useRef(new Set<string>());

  const loadMeta = useCallback(() => {
    api<Health>("/health/ready")
      .then(setHealth)
      .catch(() => setHealth(null));
    api<Config>("/config")
      .then(setConfig)
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadMeta();
    const t = setInterval(loadMeta, 60_000);
    return () => clearInterval(t);
  }, [loadMeta]);

  useEffect(() => {
    const on = () => setTab(tabFromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  // A connection that drops is worth saying out loud: reads will fail and writes
  // must not be attempted twice.
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    addEventListener("online", up);
    addEventListener("offline", down);
    return () => {
      removeEventListener("online", up);
      removeEventListener("offline", down);
    };
  }, []);

  // ⌘K focuses search; Escape closes whatever is open; "/" jumps to search.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.tagName === "SELECT" ||
          e.target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        setSearchOpen(true);
      } else if (e.key === "/" && !typing && me) {
        e.preventDefault();
        searchRef.current?.focus();
        setSearchOpen(true);
      } else if (e.key === "Escape") {
        setSearchOpen(false);
        setNotifOpen(false);
        setDrawer(false);
        searchRef.current?.blur();
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [me]);

  // Close popovers on any press outside them.
  useEffect(() => {
    const on = (e: PointerEvent) => {
      const node = e.target as Node;
      if (searchWrap.current && !searchWrap.current.contains(node)) setSearchOpen(false);
      if (toolWrap.current && !toolWrap.current.contains(node)) setNotifOpen(false);
    };
    addEventListener("pointerdown", on);
    return () => removeEventListener("pointerdown", on);
  }, []);

  useEffect(() => {
    const q = search.trim();
    if (!q || !me) {
      setResults(null);
      setSearching(false);
      return;
    }
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api<SearchResults>(`/search${query({ q, limit: 5 })}`)
        .then((r) => setResults(r))
        .catch(() => setResults({ events: [], clubs: [], people: [] }))
        .finally(() => setSearching(false));
    }, 220);
    return () => clearTimeout(t);
  }, [search, me]);

  const available = useMemo(() => {
    const list: Tab[] = ["dashboard"];
    if (isClubMember || isAdmin || isSenior) list.push("events");
    if (isStaff) list.push("approvals");
    if (isFaculty || isSenior) list.push("verification");
    if (isAdmin || isSenior) list.push("students");
    list.push("resources");
    if (isClubMember || isStaff) list.push("clubs", "reports");
    // An HOD/Dean opens Administration for their own department; the API scopes it.
    if (isAdmin || isSenior) list.push("admin");
    if (isAdmin) list.push("audit");
    list.push("account");
    return list;
  }, [isClubMember, isStaff, isFaculty, isSenior, isAdmin]);
  const allowed = new Set(available);
  const active: Tab = tab && allowed.has(tab) ? tab : "dashboard";
  const mayUseConsole = isStaff || isClubMember;

  const refreshDash = useCallback(() => {
    if (!me) return;
    api<DashboardData>("/me/dashboard")
      .then(setDash)
      .catch(() => {});
  }, [me]);

  useEffect(() => {
    refreshDash();
  }, [refreshDash]);

  // The badge is a server-side count. Coming back to the tab (or focusing the
  // window) is a cheap moment to re-sync it after an action in another view.
  useEffect(() => {
    function sync() {
      if (document.visibilityState === "visible") refreshDash();
    }
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [refreshDash]);

  const navigate = useCallback((next: string) => {
    setDrawer(false);
    setNotifOpen(false);
    setSearchOpen(false);
    setResults(null);
    setSearch("");
    if (next === "events:new") {
      setTab("events");
      location.hash = "/events";
      setNewDraft((n) => n + 1);
      return;
    }
    if (isTab(next)) {
      setTab(next);
      location.hash = `/${next}`;
    }
  }, []);
  const openEvent = useCallback(
    (id: string) => {
      setFocusEvent(id);
      navigate("events");
    },
    [navigate],
  );
  const consumeFocus = useCallback(() => setFocusEvent(null), []);
  const prefetch = useCallback((t: Tab) => {
    if (t === "dashboard" || prefetched.current.has(t)) return;
    const loader = loaders[t as keyof typeof loaders];
    if (!loader) return;
    prefetched.current.add(t);
    void loader().catch(() => prefetched.current.delete(t));
  }, []);

  async function onAuthenticated(token: string) {
    await signIn(token);
    setTab(null);
    location.hash = "/dashboard";
  }

  const themeBtn = (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
      title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
    >
      <Icon name={theme === "light" ? "moon" : "sun"} size={16} />
    </button>
  );

  // Members of a club only see their own clubs, so the section reads "My club"
  // for them. Admin and HOD/Dean keep the institution/department-wide label.
  const tabLabel = (t: Tab) =>
    t === "clubs" && !isAdmin && !isSenior ? "My club" : TAB_META[t].label;
  const pageTitle = tabLabel(active);
  const attention = dash
    ? dash.work.approvalsPending + dash.work.verificationPending + dash.work.openComplaints
    : 0;

  // Kept above the early returns: a hook may not appear after them.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    document.title = attention
      ? `(${attention}) ${pageTitle} · CampusOps`
      : `${pageTitle} · CampusOps`;
  }, [pageTitle, attention]);

  if (loading)
    return (
      <div className="boot-screen" aria-busy="true" aria-live="polite">
        <span className="boot-mark" aria-hidden="true">
          <Icon name="ticket" size={21} />
        </span>
        <div className="boot-copy">
          <b>CampusOps</b>
          <span>Restoring your session</span>
        </div>
      </div>
    );

  if (!me)
    return (
      <div className="auth-layout">
        <a className="skip-link" href="#auth-form">
          Skip to sign in
        </a>
        <aside className="auth-hero">
          <div>
            <Logo />
            <div className="auth-hero-body">
              <p className="eyebrow">Management console</p>
              <h1>
                The campus,
                <br />
                <em>in order.</em>
              </h1>
              <p>
                One desk for the people who run the day: permissions, rooms, QR passes and the
                record that outlives the event. Students take part in the CampusOps app.
              </p>
              <div className="hero-proof">
                <div className="hero-proof-item">
                  <span>01</span>
                  <div>
                    <b>Every permission decided on its own</b>
                    <em>Its own approver, its own due date, its own trail.</em>
                  </div>
                </div>
                <div className="hero-proof-item">
                  <span>02</span>
                  <div>
                    <b>Rooms that cannot double-book</b>
                    <em>The overlap is rejected by the database, not by hope.</em>
                  </div>
                </div>
                <div className="hero-proof-item">
                  <span>03</span>
                  <div>
                    <b>Passes that expire in your hand</b>
                    <em>Rotating codes, one nonce each. A screenshot is not a ticket.</em>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="auth-hero-foot">
            <span>
              CampusOps · <b>Event operations</b>
            </span>
            <span>
              For <b>{config?.institutionName ?? "your institution"}</b>
            </span>
          </div>
        </aside>
        <div className="auth-panel" id="auth-form">
          <div className="auth-top">{themeBtn}</div>
          <div className="auth-panel-inner">
            <span className="auth-badge">Staff access</span>
            <AuthPanel config={config} onAuthenticated={onAuthenticated} />
          </div>
        </div>
      </div>
    );

  if (!mayUseConsole)
    return (
      <div className="auth-locked">
        <Card
          title="This console is for staff and club coordinators"
          actions={themeBtn}
          subtitle="Your account is a participant account."
        >
          <p className="lead">
            There is nothing for you to manage here. Students register, hold passes and raise issues
            in the CampusOps app.
          </p>
          <p className="meta">
            If you believe you should have console access, ask your club lead, your
            department&apos;s HOD or Dean, or the administrator. They can grant a role without
            creating a new account.
          </p>
          <div className="row">
            <button type="button" className="ghost" onClick={() => signOut(false)}>
              <Icon name="logout" size={15} /> Sign out
            </button>
          </div>
          <p className="auth-note">
            Signed in as <b>{me.user.email}</b>
          </p>
        </Card>
      </div>
    );

  const initials = me.user.fullName
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const roleLabel = isAdmin
    ? "Administrator"
    : isSenior
      ? "HOD / Dean"
      : isFaculty
        ? "Faculty"
        : "Club coordinator";
  const groups = ["Workspace", "Institution", "You"] as const;
  const now = new Date();
  const emptyQuery = search.trim().length < 2;
  const navMatches: Extract<PaletteItem, { kind: "tab" }>[] = emptyQuery
    ? available.map((t) => ({
        kind: "tab" as const,
        tab: t,
        label: TAB_META[t].label,
        icon: TAB_META[t].icon,
        hint: TAB_META[t].group,
      }))
    : available
        .filter((t) => TAB_META[t].label.toLowerCase().includes(search.trim().toLowerCase()))
        .map((t) => ({
          kind: "tab" as const,
          tab: t,
          label: TAB_META[t].label,
          icon: TAB_META[t].icon,
          hint: TAB_META[t].group,
        }));
  const actions: Extract<PaletteItem, { kind: "action" }>[] = emptyQuery
    ? [
        ...(isClubMember
          ? [
              {
                kind: "action" as const,
                action: "new" as const,
                label: "New event draft",
                icon: "calendar-plus",
              },
            ]
          : []),
        {
          kind: "action",
          action: "theme",
          label: `Switch to ${theme === "light" ? "dark" : "light"} theme`,
          icon: theme === "light" ? "moon" : "sun",
        },
        { kind: "action", action: "signout", label: "Sign out", icon: "logout" },
      ]
    : [];
  const eventItems: Extract<PaletteItem, { kind: "event" }>[] = (results?.events ?? []).map(
    (r) => ({
      kind: "event",
      id: r.id,
      title: r.title,
      when: new Date(r.startsAt).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
      }),
      status: r.status,
    }),
  );
  const clubItems: Extract<PaletteItem, { kind: "club" }>[] = (results?.clubs ?? []).map((c) => ({
    kind: "club",
    id: c.id,
    name: c.name,
    detail: c.description ?? "Club",
  }));
  const personItems: Extract<PaletteItem, { kind: "person" }>[] = (results?.people ?? []).map(
    (p) => ({
      kind: "person",
      id: p.id,
      name: p.fullName,
      detail: `${p.email} · ${p.status.replace(/_/g, " ").toLowerCase()}`,
      role: p.role,
      roles: p.roles,
    }),
  );
  const palette: PaletteItem[] = [
    ...(emptyQuery ? [] : eventItems),
    ...(emptyQuery ? [] : clubItems),
    ...(emptyQuery ? [] : personItems),
    ...navMatches,
    ...actions,
  ];
  const showPalette = searchOpen && me;

  function choose(item: PaletteItem) {
    if (item.kind === "event") {
      if (isClubMember) openEvent(item.id);
      else navigate("reports");
      return;
    }
    if (item.kind === "club") {
      navigate("clubs");
      return;
    }
    if (item.kind === "person") {
      navigate("admin");
      return;
    }
    if (item.kind === "tab") {
      prefetch(item.tab);
      navigate(item.tab);
      return;
    }
    if (item.action === "new") navigate("events:new");
    else if (item.action === "theme") toggle();
    else void signOut(false);
    setSearchOpen(false);
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSearchOpen(true);
      setActiveIndex((i) => Math.min(palette.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const item = palette[activeIndex];
      if (item) {
        e.preventDefault();
        choose(item);
      }
    }
  }

  let runningIndex = -1;
  const itemIndex = () => ++runningIndex;

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {drawer && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close menu"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside className={`sidebar ${drawer ? "open" : ""}`} aria-label="Primary">
        <div className="sidebar-brand">
          <button
            type="button"
            className="link"
            onClick={() => navigate("dashboard")}
            aria-label="CampusOps dashboard"
            style={{ padding: 0, background: "none" }}
          >
            <Logo />
          </button>
          <button
            type="button"
            className="icon-btn sidebar-close"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="sidebar-date">
          <span className="status-dot live" />
          {longDate(now)}
          <span style={{ marginLeft: "auto" }}>{String(now.getFullYear())}</span>
        </div>
        <div className="sidebar-scroll">
          <nav className="tabs" aria-label="Sections">
            {groups.map((g) => {
              const items = available.filter((t) => TAB_META[t].group === g);
              if (!items.length) return null;
              return (
                <div key={g}>
                  <div className="nav-label">{g}</div>
                  {items.map((t) => {
                    const count =
                      t === "approvals"
                        ? dash?.work.approvalsPending
                        : t === "verification"
                          ? dash?.work.verificationPending
                          : undefined;
                    return (
                      <button
                        key={t}
                        type="button"
                        className={active === t ? "active" : ""}
                        aria-current={active === t ? "page" : undefined}
                        onClick={() => navigate(t)}
                        onPointerEnter={() => prefetch(t)}
                        onFocus={() => prefetch(t)}
                      >
                        <Icon name={TAB_META[t].icon} size={17} />
                        {tabLabel(t)}
                        {count ? <span className="nav-count">{count}</span> : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </div>
        <div className="sidebar-foot">
          <div className="sidebar-card">
            <strong>
              <span className={`status-dot ${health ? "" : "bad"}`} />
              {health ? "Systems nominal" : "API unreachable"}
            </strong>
            <div className="status-bar">
              <span>
                DB <strong>{health?.checks.database ?? "—"}</strong>
              </span>
              <span>
                Email <strong>{config?.emailMode ?? "—"}</strong>
              </span>
              <span>
                Files <strong>{config?.storageMode ?? "—"}</strong>
              </span>
            </div>
            {config?.demoMode && <span className="badge warn">Demo mode</span>}
          </div>
          <div className="sidebar-user">
            <span className="avatar">{initials}</span>
            <span className="who">
              <b>{me.user.fullName}</b>
              <span>{roleLabel}</span>
            </span>
            <button
              type="button"
              className="icon-btn"
              style={{ width: 30, height: 30 }}
              aria-label="Sign out"
              title="Sign out"
              onClick={() => signOut(false)}
            >
              <Icon name="logout" size={15} />
            </button>
          </div>
          <div className="sidebar-credit">
            {/* The institution this deployment belongs to, not the developer's
                name: a signed-in staff member is looking at their college. */}
            <span>CampusOps</span>
            <b title="Institution">
              <span className="credit-dot" />
              {config?.institutionName ?? "Institution"}
            </b>
          </div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
          >
            <Icon name="menu" size={18} />
          </button>
          <div className="crumb">
            CampusOps <Icon name="chevron" size={12} /> <b>{pageTitle}</b>
          </div>
          <div className="searchbox" ref={searchWrap}>
            <Icon name="search" size={15} className="search-icon" />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search events, clubs or people"
              aria-label="Search events, clubs and people"
              value={search}
              onFocus={() => {
                setActiveIndex(0);
                setSearchOpen(true);
              }}
              onChange={(e) => {
                setActiveIndex(0);
                setSearch(e.target.value);
                setSearchOpen(true);
              }}
              onKeyDown={onSearchKey}
            />
            <kbd>
              <span className="search-mod">⌘</span>K
            </kbd>
            {showPalette && (
              <div className="popover" id="global-search-results">
                {!emptyQuery && (
                  <>
                    <h4>{searching ? "Searching" : `Events · ${eventItems.length}`}</h4>
                    {eventItems.length === 0 && !searching && (
                      <p className="popover-empty">
                        No event you can see matches “{search.trim()}”. Try a club name or a shorter
                        phrase.
                      </p>
                    )}
                    {eventItems.map((item) => {
                      const i = itemIndex();
                      if (item.kind !== "event") return null;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-current={activeIndex === i ? "true" : undefined}
                          className={`popover-item${activeIndex === i ? " is-active" : ""}`}
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => choose(item)}
                        >
                          <span className="pi-icon tone-brand">
                            <Icon name="calendar" size={15} />
                          </span>
                          <span>
                            <b>{item.title}</b>
                            <span>{item.when}</span>
                          </span>
                          <span className="pi-side">
                            {item.status.replace(/_/g, " ").toLowerCase()}
                          </span>
                        </button>
                      );
                    })}
                    {clubItems.length > 0 && <h4>Clubs · {clubItems.length}</h4>}
                    {clubItems.map((item) => {
                      const i = itemIndex();
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-current={activeIndex === i ? "true" : undefined}
                          className={`popover-item${activeIndex === i ? " is-active" : ""}`}
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => choose(item)}
                        >
                          <span className="pi-icon tone-muted">
                            <Icon name="users" size={15} />
                          </span>
                          <span>
                            <b>{item.name}</b>
                            <span>{item.detail}</span>
                          </span>
                          <span className="pi-side">Club</span>
                        </button>
                      );
                    })}
                    {personItems.length > 0 && <h4>People · {personItems.length}</h4>}
                    {personItems.map((item) => {
                      const i = itemIndex();
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-current={activeIndex === i ? "true" : undefined}
                          className={`popover-item${activeIndex === i ? " is-active" : ""}`}
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => choose(item)}
                        >
                          <span className="pi-icon tone-muted">
                            <Icon name="user" size={15} />
                          </span>
                          <span>
                            <b>{item.name}</b>
                            <span>{item.detail}</span>
                          </span>
                          <span
                            className={`pi-side role-pill role-${item.role.toLowerCase()}`}
                            title={item.roles.join(" · ")}
                          >
                            {item.role}
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}
                {emptyQuery && (
                  <>
                    <h4>Jump to</h4>
                    {navMatches.map((item) => {
                      const i = itemIndex();
                      return (
                        <button
                          key={`nav-${item.tab}`}
                          type="button"
                          aria-current={activeIndex === i ? "true" : undefined}
                          className={`popover-item${activeIndex === i ? " is-active" : ""}`}
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => choose(item)}
                        >
                          <span className="pi-icon tone-muted">
                            <Icon name={item.icon} size={15} />
                          </span>
                          <span>
                            <b>{item.label}</b>
                            <span>{item.hint}</span>
                          </span>
                          <span className="pi-side">
                            <Kbd>↵</Kbd>
                          </span>
                        </button>
                      );
                    })}
                    {actions.length > 0 && <h4>Actions</h4>}
                    {actions.map((item) => {
                      const i = itemIndex();
                      return (
                        <button
                          key={`action-${item.action}`}
                          type="button"
                          aria-current={activeIndex === i ? "true" : undefined}
                          className={`popover-item${activeIndex === i ? " is-active" : ""}`}
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => choose(item)}
                        >
                          <span className="pi-icon tone-muted">
                            <Icon name={item.icon} size={15} />
                          </span>
                          <span>
                            <b>{item.label}</b>
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}
                <div className="popover-foot">
                  <span>↑↓ to move · ↵ to open</span>
                  <span>esc to close</span>
                </div>
              </div>
            )}
          </div>
          <div className="topbar-date">{shortDate(now)}</div>
          <div className="topbar-tools" ref={toolWrap}>
            {themeBtn}
            <button
              type="button"
              className="icon-btn"
              aria-label={`Notifications${attention ? `, ${attention} need attention` : ""}`}
              aria-expanded={notifOpen}
              onClick={() => setNotifOpen((o) => !o)}
            >
              <Icon name="bell" size={16} />
              {attention > 0 && <span className="dot" />}
            </button>
            {notifOpen && (
              <div className="popover">
                <h4>Needs attention</h4>
                {attention === 0 && (
                  <p className="popover-empty">Nothing is waiting on you. The desk is clear.</p>
                )}
                {isStaff && dash && dash.work.approvalsPending > 0 && (
                  <button
                    type="button"
                    className="popover-item"
                    onClick={() => navigate("approvals")}
                  >
                    <span className="pi-icon tone-brand">
                      <Icon name="inbox" size={15} />
                    </span>
                    <span>
                      <b>
                        {dash.work.approvalsPending} approval
                        {dash.work.approvalsPending === 1 ? "" : "s"} awaiting your decision
                      </b>
                      <span>Open the approvals inbox</span>
                    </span>
                  </button>
                )}
                {(isFaculty || isSenior) && dash && dash.work.verificationPending > 0 && (
                  <button
                    type="button"
                    className="popover-item"
                    onClick={() => navigate("verification")}
                  >
                    <span className="pi-icon tone-mint">
                      <Icon name="shield" size={15} />
                    </span>
                    <span>
                      <b>
                        {dash.work.verificationPending} student
                        {dash.work.verificationPending === 1 ? "" : "s"} to verify
                      </b>
                      <span>College ID checks in your scope</span>
                    </span>
                  </button>
                )}
                {dash && dash.work.openComplaints > 0 && (
                  <button
                    type="button"
                    className="popover-item"
                    onClick={() => navigate(isClubMember ? "events" : "reports")}
                  >
                    <span className="pi-icon tone-peach">
                      <Icon name="alert" size={15} />
                    </span>
                    <span>
                      <b>
                        {dash.work.openComplaints} open participant issue
                        {dash.work.openComplaints === 1 ? "" : "s"}
                      </b>
                      <span>Event complaint inboxes</span>
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="popover-item"
                  onClick={() => navigate("dashboard")}
                >
                  <span className="pi-icon tone-muted">
                    <Icon name="dashboard" size={15} />
                  </span>
                  <span>
                    <b>The full picture</b>
                    <span>Counts, pipeline and what is next</span>
                  </span>
                </button>
              </div>
            )}
            <button
              type="button"
              className="avatar"
              style={{ border: "1px solid var(--line)", cursor: "pointer", width: 32, height: 32 }}
              aria-label="Account settings"
              onClick={() => navigate("account")}
            >
              {initials}
            </button>
          </div>
        </header>

        <main id="main-content" className="content">
          {!online && (
            <output className="offline-bar">
              <Icon name="alert" size={14} />
              <span>
                You are offline. Reading cached screens still works on the phone; this console needs
                a connection to record changes.
              </span>
            </output>
          )}
          {me.user.status !== "ACTIVE" && (
            <p className="warn-note">
              <Icon name="alert" size={15} />
              <span>
                Your account is {me.user.status.replace(/_/g, " ").toLowerCase()}. Some actions stay
                locked until an administrator activates it.
              </span>
            </p>
          )}

          <div className="page" key={active}>
            {active !== "dashboard" && (
              <div className="page-head">
                <div>
                  <p className="eyebrow">{TAB_META[active].group}</p>
                  <h1>{tabLabel(active)}</h1>
                  <p className="lead">{SECTION_LEDE[active]}</p>
                </div>
              </div>
            )}
            <ErrorBoundary key={active}>
              <Suspense fallback={<PanelSkeleton />}>
                {active === "dashboard" && (
                  <DashboardPanel onNavigate={navigate} onOpenEvent={openEvent} />
                )}
                {active === "events" && (isClubMember || isAdmin || isSenior) && (
                  <CoordinatorPanel
                    focusEventId={focusEvent}
                    onFocusConsumed={consumeFocus}
                    newDraftSignal={newDraft}
                  />
                )}
                {active === "approvals" && isStaff && <ApprovalsPanel onChanged={refreshDash} />}
                {active === "verification" && (isFaculty || isSenior) && (
                  <VerificationPanel onChanged={refreshDash} />
                )}
                {active === "students" && (isAdmin || isSenior) && <StudentsPanel />}
                {active === "resources" && <ResourcesPanel />}
                {active === "clubs" && (isClubMember || isStaff) && <ClubsPanel />}
                {active === "reports" && (isClubMember || isStaff) && <ReportsPanel />}
                {active === "admin" && (isAdmin || isSenior) && <AdminPanel />}
                {active === "audit" && isAdmin && <AuditPanel />}
                {active === "account" && <AccountPanel />}
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <Card title="This screen stopped responding" subtitle="The rest of the console is fine.">
          <p className="bad-note" role="alert">
            <Icon name="alert" size={15} />
            <span>{this.state.error.message}</span>
          </p>
          <p className="meta">
            Your data is safe. Reload this section; if it keeps happening, share the request id from
            the API response with the administrator.
          </p>
          <div className="row">
            <button type="button" onClick={() => this.setState({ error: null })}>
              <Icon name="refresh" size={15} /> Try again
            </button>
            <button type="button" className="ghost" onClick={() => location.reload()}>
              Reload the console
            </button>
          </div>
        </Card>
      );
    return this.props.children;
  }
}
