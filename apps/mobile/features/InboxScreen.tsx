import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  Empty,
  Loading,
  Muted,
  Note,
  Screen,
  Title,
  colors,
} from "../components/ui";
import { type Page, api, errorMessage } from "../lib/api";
import { when } from "../lib/format";
import type { Announcement } from "../lib/quizTypes";

/**
 * Announcement inbox. Read state lives on the server so it follows the account
 * across phones, and opening an item marks it read exactly once (the endpoint is
 * idempotent).
 */
export function InboxScreen({ onOpenEvent }: { onOpenEvent?: (eventId: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Announcement[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<Page<Announcement> & { unread: number }>("/me/announcements?limit=50");
      setItems(data.items);
      setUnread(data.unread);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function read(item: Announcement) {
    setOpen(open === item.id ? null : item.id);
    if (item.readAt) return;
    setBusy(true);
    try {
      await api(`/me/announcements/${item.id}/read`, {});
      // Optimistic locally, then reconciled with the server's count.
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)),
      );
      setUnread((n) => Math.max(0, n - 1));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <Screen>
        <Loading label="Loading announcements…" />
      </Screen>
    );

  return (
    <Screen>
      <Title
        eyebrow="From your coordinators"
        title="Announcements"
        subtitle="Venue changes, timings and the instructions that actually matter, for events you are part of."
      />
      <Note message={error} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Badge
          label={unread === 0 ? "All caught up" : `${unread} unread`}
          tone={unread ? "primary" : "good"}
        />
        <Button label="Refresh" variant="ghost" onPress={() => void load()} />
      </View>

      {items.length === 0 ? (
        <Empty
          title="Nothing yet"
          detail="When a coordinator posts an update for one of your events, it appears here."
        />
      ) : (
        items.map((item) => {
          const expanded = open === item.id;
          return (
            <Card key={item.id} title={item.title}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                {item.isPinned && <Badge label="Pinned" tone="warn" />}
                {!item.readAt && <Badge label="New" tone="primary" />}
              </View>
              <Muted>{item.event?.title ?? "Event update"}</Muted>
              <Text
                style={{ color: colors.ink, lineHeight: 21, marginTop: 6 }}
                numberOfLines={expanded ? undefined : 2}
              >
                {item.body}
              </Text>
              <Muted>{when(item.publishedAt)}</Muted>
              <Button
                label={expanded ? "Close" : item.readAt ? "Read again" : "Read"}
                variant="ghost"
                busy={busy && open === item.id}
                onPress={() => void read(item)}
                testID={`announcement-${item.id}`}
              />
              {expanded && onOpenEvent && (
                <Button
                  label="Open this event"
                  variant="ghost"
                  onPress={() => onOpenEvent(item.event.id)}
                />
              )}
            </Card>
          );
        })
      )}
    </Screen>
  );
}
