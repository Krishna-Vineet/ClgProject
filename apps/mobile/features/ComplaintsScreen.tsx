import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_CATEGORY_LABELS,
  type ComplaintCategory,
} from "@campusops/shared/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  Field,
  Loading,
  Muted,
  Note,
  Row,
  Screen,
  ScreenOverlay,
  Title,
  colors,
} from "../components/ui";
import { type Page, api, errorMessage } from "../lib/api";
import { statusLabel, when } from "../lib/format";
import { useSession } from "../lib/session";
import type { Complaint, ComplaintDetail, ComplaintLocation } from "../lib/types";

export function ComplaintsScreen({
  locationId,
  onLocation,
  onScan,
}: { locationId: string | null; onLocation: (id: string | null) => void; onScan: () => void }) {
  const { config } = useSession();
  const [items, setItems] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [location, setLocation] = useState<ComplaintLocation | null>(null);
  const [detail, setDetail] = useState<ComplaintDetail | null>(null);
  const [category, setCategory] = useState<ComplaintCategory>("OTHER");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const page = await api<Page<Complaint>>(`/me/complaints?limit=20&offset=${offset}`);
      setItems((old) => (offset ? [...old, ...page.items] : page.items));
      setHasMore(Boolean(page.hasMore));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setLocation(null);
    setError(null);
    setNotice(null);
    if (!locationId) return;
    let alive = true;
    api<ComplaintLocation>(`/complaints/locations/${locationId}`)
      .then((d) => {
        if (!d?.location?.id || !d?.event?.id)
          throw new Error(
            "This QR did not resolve to a full reporting point. Ask the organiser for a new poster.",
          );
        if (alive) setLocation(d);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [locationId]);

  async function submit() {
    if (!locationId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/complaints/locations/${locationId}/reports`, {
        category,
        description: description.trim(),
      });
      setNotice("Issue reported. Only this event's organisers can see and act on it.");
      setDescription("");
      onLocation(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setError(null);
    setDetail(null);
    try {
      setDetail(await api<ComplaintDetail>(`/complaints/${id}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const tz = config?.campusTimezone ?? "Asia/Kolkata";

  if (detail)
    return (
      <Screen>
        <Button label="← Back to my issues" variant="ghost" onPress={() => setDetail(null)} />
        <Title title="Issue progress" subtitle={detail.complaint.locationLabel} />
        <Note message={error} />
        <Card>
          <Badge
            label={statusLabel(detail.complaint.status)}
            tone={
              detail.complaint.status === "RESOLVED" || detail.complaint.status === "CLOSED"
                ? "good"
                : "warn"
            }
          />
          <Muted>{COMPLAINT_CATEGORY_LABELS[detail.complaint.category]}</Muted>
          <Text style={{ color: colors.ink, lineHeight: 22 }}>{detail.complaint.description}</Text>
        </Card>
        <Card title="Updates">
          {detail.updates.length === 0 ? (
            <Muted>No updates yet.</Muted>
          ) : (
            detail.updates.map(({ update, actor }) => (
              <View key={update.id} style={{ gap: 4 }}>
                <Badge label={statusLabel(update.toStatus)} />
                <Muted>
                  {actor.fullName} · {when(update.createdAt, tz)}
                </Muted>
                {update.note && <Text style={{ color: colors.ink }}>{update.note}</Text>}
              </View>
            ))
          )}
        </Card>
      </Screen>
    );

  if (locationId)
    return (
      <Screen>
        <Button label="← Cancel report" variant="ghost" onPress={() => onLocation(null)} />
        <Title
          eyebrow="Location QR"
          title="Report an issue"
          subtitle="Your report goes to the people running this event, not a general campus inbox."
        />
        <Note message={error} />
        {!location ? (
          <Loading label="Checking location…" />
        ) : (
          <>
            <Card>
              <Row label="Event" value={location.event.title} />
              <Row label="Location" value={location.location.label} />
              <Row label="Organised by" value={location.club.name} />
              {location.location.description && <Muted>{location.location.description}</Muted>}
            </Card>
            <Card title="What's wrong?">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {COMPLAINT_CATEGORIES.map((c) => (
                  <Chip
                    key={c}
                    label={COMPLAINT_CATEGORY_LABELS[c]}
                    selected={category === c}
                    onPress={() => setCategory(c)}
                  />
                ))}
              </View>
              <Field
                label="Describe the issue"
                value={description}
                onChangeText={setDescription}
                multiline
                maxLength={4000}
                placeholder="What happened, and where exactly?"
                hint="At least 5 characters. Do not include passwords or other secrets."
              />
              <Button
                label="Send report"
                onPress={() => void submit()}
                busy={busy}
                disabled={description.trim().length < 5}
                testID="send-complaint"
              />
            </Card>
          </>
        )}
      </Screen>
    );

  return (
    <>
      <ScreenOverlay visible={busy} label="Sending your report" />
      <Screen>
        <Title
          eyebrow="Event help"
          title="My reported issues"
          subtitle="Scan a location poster to raise a new issue."
        />
        <Button label="Scan a location QR" onPress={onScan} />
        <Note message={notice} tone="good" />
        <Note message={error} />
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty
            doodle="megaphone"
            title="No issues reported"
            detail="Reports you send from an event location will appear here."
          />
        ) : (
          items.map((item) => (
            <Pressable key={item.id} accessibilityRole="button" onPress={() => void open(item.id)}>
              <Card>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ fontWeight: "700", color: colors.ink, flex: 1 }}>
                    {item.locationLabel}
                  </Text>
                  <Badge
                    label={statusLabel(item.status)}
                    tone={item.status === "RESOLVED" || item.status === "CLOSED" ? "good" : "warn"}
                  />
                </View>
                <Muted>
                  {item.eventTitle} · {when(item.createdAt, tz)}
                </Muted>
                <Text numberOfLines={2} style={{ color: colors.ink }}>
                  {item.description}
                </Text>
              </Card>
            </Pressable>
          ))
        )}
        {hasMore && (
          <Button label="Load more" variant="ghost" onPress={() => void load(items.length)} />
        )}
      </Screen>
    </>
  );
}
