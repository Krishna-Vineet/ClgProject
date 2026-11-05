import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { errorMessage } from "../lib/api";
import { Icon } from "./icons";
import { Skeleton } from "./ui";

type ToastKind = "ok" | "err" | "info";
type Toast = { id: number; kind: ToastKind; text: string; leaving?: boolean };
type ToastApi = {
  ok: (text: string) => void;
  err: (text: string) => void;
  info: (text: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Global notices, kept out of the panel that triggered them. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    // Let the exit transition play before the node is removed.
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 180);
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, kind, text }]);
      const timer = setTimeout(() => dismiss(id), kind === "err" ? 7000 : 4500);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const value = useMemo<ToastApi>(
    () => ({
      ok: (text) => push("ok", text),
      err: (text) => push("err", text),
      info: (text) => push("info", text),
    }),
    [push],
  );

  /**
   * The toast host is a *popover*, not a positioned div.
   *
   * Anything inside `.shell` loses to `dialog::backdrop`, which the browser
   * paints in the top layer above every z-index. A toast raised from inside a
   * modal was therefore dimmed and blurred behind the backdrop — exactly when it
   * mattered most ("that did not save"). A manual popover also lives in the top
   * layer, and because it is opened after the dialog it stacks above it.
   */
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const popover = el as HTMLDivElement & {
      showPopover?: () => void;
      hidePopover?: () => void;
    };
    if (toasts.length > 0) {
      // Re-showing is harmless and keeps us above a dialog opened later.
      try {
        if (!el.matches(":popover-open")) popover.showPopover?.();
      } catch {
        // A browser without the popover API simply falls back to z-index.
      }
    } else {
      try {
        if (el.matches(":popover-open")) popover.hidePopover?.();
      } catch {
        /* ignore */
      }
    }
  }, [toasts.length]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* A div, not <output>: React's typing for <output> predates the popover
          attribute, and a live region is what matters here, not the tag. */}
      <div
        ref={hostRef}
        {...({ popover: "manual" } as Record<string, string>)}
        className="toasts"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}${t.leaving ? " leaving" : ""}`}>
            <span className="toast-icon" aria-hidden="true">
              <Icon
                name={t.kind === "ok" ? "check-circle" : t.kind === "err" ? "alert" : "info"}
                size={16}
              />
            </span>
            <span className="toast-text">{t.text}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

/**
 * Runs an action, reporting failures as a toast instead of leaving the caller to
 * wire up try/catch and an error banner in every panel.
 */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        const message = await fn();
        if (typeof message === "string") toast.ok(message);
        return true;
      } catch (err) {
        toast.err(errorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

/** Modal confirmation for anything destructive or irreversible. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  danger = true,
  reasonLabel,
  reasonRequired = false,
  busy = false,
  onCancel: dismiss,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string | undefined;
  confirmLabel?: string | undefined;
  danger?: boolean | undefined;
  reasonLabel?: string | undefined;
  reasonRequired?: boolean | undefined;
  busy?: boolean | undefined;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // A native <dialog> gives a real focus trap, an inert background and Escape
  // handling, which a styled <div> cannot do accessibly.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      setReason("");
      if (!el.open) el.showModal();
      confirmRef.current?.focus();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  const blocked = busy || (reasonRequired && reason.trim().length < 3);

  return (
    <dialog
      className="modal"
      ref={dialogRef}
      aria-label={title}
      onCancel={(e) => {
        // Escape must not close a dialog while its request is in flight.
        e.preventDefault();
        if (!busy) dismiss();
      }}
    >
      <div className={`modal-mark ${danger ? "danger" : ""}`} aria-hidden="true">
        <Icon name={danger ? "alert" : "check-circle"} size={18} />
      </div>
      <h3>{title}</h3>
      {description && <p className="meta">{description}</p>}
      {reasonLabel && (
        <label className="field" style={{ marginTop: 14 }}>
          <span>
            {reasonLabel}
            {reasonRequired ? " *" : ""}
          </span>
          <textarea
            rows={3}
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      <div className="row end">
        <button type="button" className="ghost" disabled={busy} onClick={dismiss}>
          Cancel
        </button>
        <button
          type="button"
          ref={confirmRef}
          className={danger ? "danger" : ""}
          disabled={blocked}
          onClick={() => onConfirm(reason.trim())}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

type ModalSize = "md" | "lg" | "wide";

/**
 * A real modal surface for transient work: create, edit, decide, invite.
 * Native <dialog> provides focus trapping, inert background and Escape, so a
 * panel never grows a second form in the page flow when a button is pressed.
 */
export function Modal({
  open,
  title,
  description,
  size = "md",
  busy = false,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  size?: ModalSize | undefined;
  busy?: boolean | undefined;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal modal-${size}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClose={() => {
        if (open && !busy) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <p className="eyebrow">CampusOps</p>
          <h3>{title}</h3>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      {description ? <p className="meta">{description}</p> : null}
      <div className="modal-body">{children}</div>
      {footer ? <div className="row end modal-footer">{footer}</div> : null}
    </dialog>
  );
}

/** Modal whose body is a form; the footer submit button drives that form. */
export function FormDialog({
  open,
  title,
  description,
  size = "md",
  submitLabel = "Save",
  busy = false,
  danger = false,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  size?: ModalSize | undefined;
  submitLabel?: string | undefined;
  busy?: boolean | undefined;
  danger?: boolean | undefined;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const formId = useId();
  return (
    <Modal
      open={open}
      title={title}
      description={description}
      size={size}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className={danger ? "danger" : ""} disabled={busy}>
            {busy ? "Working…" : submitLabel}
          </button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={onSubmit}>
        {children}
      </form>
    </Modal>
  );
}

/**
 * In-panel loading placeholder. It renders the shape of content rather than a
 * spinner, so the layout does not jump when the request resolves.
 */
export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-block" aria-busy="true" aria-label={label}>
      <span className="loading-label">{label}</span>
      <span className="skeleton-text" aria-hidden="true">
        <Skeleton height={12} width="46%" />
        <Skeleton height={12} width="88%" />
        <Skeleton height={12} width="72%" />
      </span>
    </div>
  );
}

export function Forbidden({ what }: { what: string }) {
  return (
    <output className="warn-note">
      <Icon name="lock" size={15} />
      <span>
        You do not have access to {what}. If you believe you should, ask an administrator to check
        your role assignment.
      </span>
    </output>
  );
}

/** Offset pagination matching the API's limit/offset contract. */
export function Pager({
  offset,
  limit,
  count,
  total,
  hasMore,
  onChange,
}: {
  offset: number;
  limit: number;
  count: number;
  total?: number | undefined;
  hasMore?: boolean | undefined;
  onChange: (offset: number) => void;
}) {
  const more = hasMore ?? (total !== undefined ? offset + count < total : count === limit);
  if (offset === 0 && !more) return null;
  const from = count === 0 ? 0 : offset + 1;
  return (
    <div className="row pager">
      <span className="pager-count">
        {from}–{offset + count}
        {total !== undefined ? ` of ${total}` : ""}
      </span>
      <span className="pager-buttons">
        <button
          type="button"
          className="ghost tiny"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          <Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} /> Prev
        </button>
        <button
          type="button"
          className="ghost tiny"
          disabled={!more}
          onClick={() => onChange(offset + limit)}
        >
          Next <Icon name="chevron" size={13} />
        </button>
      </span>
    </div>
  );
}
