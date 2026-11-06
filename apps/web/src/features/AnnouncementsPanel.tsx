import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, FormDialog, Loading, useAction } from "../components/feedback";
import { Card, Empty, Field, formatWhen, useNotice } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import type { EventRow } from "../lib/types";

type Row = {
  authorName?: string;
  id: string;
  title: string;
  body: string;
  audience: "REGISTERED" | "ALL_VISIBLE";
  isPinned: boolean;
  publishedAt: string;
  revokedAt: string | null;
  readCount: number;
};

/**
 * Coordinator announcements for one event. The audience is explicit because
 * "registered" and "everyone who can see the event" are different groups, and a
 * coordinator should never have to guess who received what.
 */
export function AnnouncementsPanel({
  event,
  canManage,
}: {
  event: EventRow;
  canManage: boolean;
}) {
  const action = useAction();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Action results are toasts; only a standing condition stays on the page.
  useNotice(error, null);
  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);
  const [form, setForm] = useState({
    title: "",
    body: "",
    audience: "REGISTERED" as Row["audience"],
    isPinned: false,
    push: true,
  });
  const [revoke, setRevoke] = useState<Row | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ items: Row[]; hasMore: boolean }>(
        `/events/${event.id}/announcements?limit=50`,
      );
      setItems(data.items);
      setTotal(data.items.length);
      setMore(data.hasMore);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [event.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish() {
    setError(null);
    if (form.title.trim().length < 2 || form.body.trim().length < 2) {
      setError("Give the announcement a title and a message.");
      return;
    }
    await action
      .run(async () => {
        const result = await api<{ recipients: number }>(
          `/events/${event.id}/announcements`,
          {
            title: form.title.trim(),
            body: form.body.trim(),
            audience: form.audience,
            isPinned: form.isPinned,
            push: form.push,
          },
          { method: "POST" },
        );
        setForm({ title: "", body: "", audience: form.audience, isPinned: false, push: form.push });
        return result.recipients > 0
          ? `Published to ${result.recipients} registered participant${result.recipients === 1 ? "" : "s"}.`
          : "Published. Nobody is registered yet, so it will be waiting when they are.";
      })
      .then(async (ok) => {
        if (ok) {
          setComposeOpen(false);
          await load();
        }
      });
  }

  if (loading) return <Loading label="Loading announcements…" />;

  return (
    <div className="stack">
      {canManage && (
        <Card
          title="Announcements"
          subtitle="Participants read these in the app; the inbox is the source of truth."
          actions={
            <button type="button" onClick={() => setComposeOpen(true)}>
              New announcement
            </button>
          }
        >
          <p className="meta" style={{ margin: 0 }}>
            Write once for everyone registered, or for everyone who can see the event. Pinned
            announcements stay at the top of the app.
          </p>
        </Card>
      )}

      <FormDialog
        open={composeOpen}
        title="New announcement"
        description="Published immediately. Recipients also get an in-app notification when enabled."
        submitLabel="Publish announcement"
        size="lg"
        busy={action.busy}
        onClose={() => setComposeOpen(false)}
        onSubmit={(e) => {
          e.preventDefault();
          void publish();
        }}
      >
        <div className="grid-2">
          <Field label="Title">
            <input
              value={form.title}
              maxLength={120}
              placeholder="Venue changed to Seminar Hall 2"
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Who should see it">
            <select
              value={form.audience}
              onChange={(e) => setForm({ ...form, audience: e.target.value as Row["audience"] })}
            >
              <option value="REGISTERED">Registered participants only</option>
              <option value="ALL_VISIBLE">Everyone who can see this event</option>
            </select>
          </Field>
        </div>
        <Field label="Message">
          <textarea
            rows={4}
            value={form.body}
            maxLength={2000}
            placeholder="Please bring your college ID to the new venue. Reporting time is unchanged."
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.isPinned}
            onChange={(e) => setForm({ ...form, isPinned: e.target.checked })}
          />
          Pin to the top of the event
        </label>
        {form.audience === "REGISTERED" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.push}
              onChange={(e) => setForm({ ...form, push: e.target.checked })}
            />
            Also notify registered participants (email and app notification)
          </label>
        )}
      </FormDialog>

      <Card title={`Published · ${total}${more ? "+" : ""}`}>
        {items.length === 0 ? (
          <Empty>No announcements yet for this event.</Empty>
        ) : (
          <ul className="list">
            {items.map((a) => (
              <li key={a.id}>
                <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <strong>{a.title}</strong>
                      {a.isPinned && <span className="chip">Pinned</span>}
                      <span className="chip">
                        {a.audience === "REGISTERED" ? "Registered" : "All who can see"}
                      </span>
                      {a.revokedAt && <span className="badge bad">Withdrawn</span>}
                    </div>
                    <p style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{a.body}</p>
                    <p className="meta">
                      {formatWhen(a.publishedAt)}
                      {a.audience === "REGISTERED" && ` · read by ${a.readCount}`}
                    </p>
                  </div>
                  {canManage && !a.revokedAt && (
                    <button type="button" className="ghost" onClick={() => setRevoke(a)}>
                      Withdraw
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(revoke)}
        title={`Withdraw “${revoke?.title ?? ""}”?`}
        description="It disappears from participants' inboxes immediately. Notifications already delivered cannot be recalled."
        confirmLabel="Withdraw"
        busy={action.busy}
        onCancel={() => setRevoke(null)}
        onConfirm={() => {
          const target = revoke;
          if (!target) return;
          void action
            .run(async () => {
              await api(`/announcements/${target.id}`, undefined, { method: "DELETE" });
              return "Announcement withdrawn.";
            })
            .then(async (ok) => {
              setRevoke(null);
              if (ok) await load();
            });
        }}
      />
    </div>
  );
}
