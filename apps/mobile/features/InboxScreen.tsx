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
 * Announcement inbox.
 *
 * Seeing the list *is* reading it: opening this tab clears the unread badge in
 * one call, and the announcements stay here afterwards because they are updates
 * about events the student is part of, not messages to be archived. The only
 * thing a tap does now is expand a long body — there is no read/unread toggle to
 * get out of step with the badge.
 */
export function InboxScreen({ onOpenEvent }: { onOpenEvent?: (eventId: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Announcement[]>([]);
  const [unread, setUnread] = useState(0);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<Page<Announcement> & { unread: number }>("/me/announcements?limit=50");
      setItems(data.items);
      setUnread(data.unread);
      // Mark what arrived since the last visit, then clear the badge for good.
      // The "New" chips are derived from this snapshot, so they survive the
      // badge being cleared — the student still sees what changed.
      setNewIds(new Set(data.items.filter((i) => !i.readAt).map((i) => i.id)));
      if (data.unread > 0) {
        try {
          await api("/me/announcements/read-all", {});
          setUnread(0);
        } catch {
          // A failed mark-read must not hide the announcements themselves; the
          // badge simply stays until the next visit succeeds.
        }
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
          label={unread === 0 ? "All caught up" : `${unread} new`}
          tone={unread ? "primary" : "good"}
        />
        <Button label="Refresh" variant="ghost" onPress={() => void load()} />
      </View>

      {items.length === 0 ? (
        <Empty
          doodle="megaphone"
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
                {newIds.has(item.id) && <Badge label="New" tone="primary" />}
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
                label={expanded ? "Show less" : "Show more"}
                variant="ghost"
                onPress={() => setOpen(expanded ? null : item.id)}
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
