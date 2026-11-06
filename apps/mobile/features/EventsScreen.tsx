import {
  ADMISSION_MODE_LABELS,
  ELIGIBILITY_REASON_LABELS,
  EVENT_AUDIENCE_LABELS,
  EVENT_TEMPLATE_LABELS,
  type EligibilityReason,
} from "@campusops/shared/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AppIcon } from "../components/icons";
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
  Title,
  colors,
  fonts,
} from "../components/ui";
import { type Page, api, errorMessage, query } from "../lib/api";
import { eventTone, statusLabel, when } from "../lib/format";
import { useSession } from "../lib/session";
import type { EventRow, ParticipantView, Registration } from "../lib/types";

export function EventsScreen({
  openEventId,
  onOpenConsumed,
  onOpenPasses,
  onOpenQuiz,
}: {
  /** An event to open on arrival, e.g. from an announcement. */
  openEventId?: string | null;
  onOpenConsumed?: () => void;
  onOpenPasses: () => void;
  onOpenQuiz?: (eventId: string, title: string) => void;
}) {
  const { me, config } = useSession();
  const [tab, setTab] = useState<"discover" | "mine">("discover");
  const [filter, setFilter] = useState<"all" | "upcoming" | "past">("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ParticipantView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const tz = config?.campusTimezone ?? "Asia/Kolkata";

  const load = useCallback(
    async (offset = 0) => {
      setLoading(true);
      setError(null);
      try {
        if (tab === "discover") {
          const page = await api<Page<EventRow>>(
            `/events${query({ q: appliedSearch, limit: 20, offset })}`,
          );
          setEvents((old) => (offset ? [...old, ...page.items] : page.items));
          setHasMore(Boolean(page.hasMore));
        } else {
          const page = await api<Page<Registration>>(
            `/me/registrations${query({ limit: 20, offset })}`,
          );
          setRegistrations((old) => (offset ? [...old, ...page.items] : page.items));
          setHasMore(Boolean(page.hasMore));
        }
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [tab, appliedSearch],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!openEventId) return;
    setSelected(openEventId);
    onOpenConsumed?.();
  }, [openEventId, onOpenConsumed]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetail(null);
    setError(null);
    api<ParticipantView>(`/events/${selected}/participant`)
      .then((d) => {
        // A truncated or mock payload used to reach the renderer and crash on
        // `detail.event.title`. Fail with a readable message instead.
        if (!d?.event?.id)
          throw new Error("Event details are incomplete. Pull to refresh and try again.");
        if (alive) setDetail(d);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  async function withdraw() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/events/${selected}/withdraw`, {});
      setDetail(await api<ParticipantView>(`/events/${selected}/participant`));
      setNotice("You've given up your place. Someone on the waitlist has been moved up.");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ registration: { status: string }; alreadyRegistered: boolean }>(
        `/events/${selected}/register`,
        {},
        { idempotencyKey: `register-${selected}-${me?.user.id}` },
      );
      setDetail(await api<ParticipantView>(`/events/${selected}/participant`));
      setNotice(
        result.registration.status === "CONFIRMED"
          ? "You're confirmed. Your pass is ready."
          : result.registration.status === "WAITLISTED"
            ? "You're on the waitlist. We'll show your position here."
            : "Application submitted for coordinator selection.",
      );
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (selected)
    return (
      <Screen>
        <Button
          label="← Back to events"
          variant="ghost"
          onPress={() => {
            setSelected(null);
            setNotice(null);
            setError(null);
          }}
        />
        <Note message={error} />
        <Note message={notice} tone="good" />
        {!detail ? (
          <Loading label="Loading event…" />
        ) : (
          <>
            <Title
              eyebrow={detail.club.name}
              title={detail.event.title}
              subtitle={EVENT_TEMPLATE_LABELS[detail.event.template]}
            />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Badge
                label={statusLabel(detail.event.status)}
                tone={eventTone(detail.event.status)}
              />
              <Badge label={EVENT_AUDIENCE_LABELS[detail.event.audience]} />
            </View>
            <Card title="When & where">
              <Row label="Starts" value={when(detail.event.startsAt, tz)} />
              <Row label="Ends" value={when(detail.event.endsAt, tz)} />
              <Row label="Venue" value={detail.event.venueSummary ?? "To be announced"} />
              <Row
                label="Registration closes"
                value={when(detail.event.registrationClosesAt, tz)}
              />
              <Row label="Admission" value={ADMISSION_MODE_LABELS[detail.event.admissionMode]} />
              <Row
                label="Seats"
                value={
                  detail.seatsRemaining === null
                    ? `${detail.confirmedCount} confirmed / ${detail.event.capacity} capacity`
                    : `${detail.seatsRemaining} left of ${detail.event.capacity}`
                }
              />
            </Card>
            <Card title="About">
              <Muted>
                {detail.event.description || "The coordinator has not added a description yet."}
              </Muted>
            </Card>
            {/*
              The number is the point. A student stuck at the gate at 09:55 needs
              a human, and "contact your coordinator" without a number is advice,
              not help. Numbers are only shown where the club actually has one.
            */}
            {detail.contacts && detail.contacts.length > 0 && (
              <Card title="Who to call">
                {detail.contacts.map((c) => (
                  <Row
                    key={c.id}
                    label={`${c.role === "FACULTY" ? "Club faculty" : "Club lead"} · ${c.fullName}`}
                    value={c.phone ?? "No number on file"}
                  />
                ))}
                <Muted>
                  Tap a number in your phone's dialler. Club faculty approve exceptions.
                </Muted>
              </Card>
            )}
            {detail.event.jobDescription && (
              <Card title="Job description">
                <Muted>{detail.event.jobDescription}</Muted>
              </Card>
            )}
            {detail.event.cancellationReason && (
              <Note message={`Cancelled: ${detail.event.cancellationReason}`} />
            )}
            {/*
              A student's job is one thing at a time: register first, then take
              the quiz that decides the seat. Offering "Open the quiz" before the
              registration exists just leads to an error screen.
            */}
            {detail.registration &&
              (detail.event.admissionMode === "QUIZ_TOP_N" ||
                detail.event.admissionMode === "QUIZ_FIRST_QUALIFIED") &&
              onOpenQuiz && (
                <Card title="Seats are decided by a quiz">
                  <Muted>
                    {detail.event.admissionMode === "QUIZ_TOP_N"
                      ? "Take the quiz before it closes. The highest scores get the seats once it is graded."
                      : "Take the quiz and reach the pass mark to claim a seat. Seats go to the first who qualify, until full."}
                  </Muted>
                  <Button
                    label="Open the quiz"
                    onPress={() => onOpenQuiz(detail.event.id, detail.event.title)}
                    testID="open-quiz"
                  />
                </Card>
              )}
            {detail.registration ? (
              <Card title="Your registration">
                <Badge
                  label={statusLabel(detail.registration.status)}
                  tone={detail.registration.status === "CONFIRMED" ? "good" : "warn"}
                />
                {detail.registration.queuePosition && (
                  <Muted>Waitlist position {detail.registration.queuePosition}</Muted>
                )}
                {detail.registration.status === "CONFIRMED" && (
                  <Button label="Open my pass" onPress={onOpenPasses} />
                )}
                {(detail.event.admissionMode === "QUIZ_TOP_N" ||
                  detail.event.admissionMode === "QUIZ_FIRST_QUALIFIED") &&
                  detail.registration.status === "APPLIED" && (
                    <Muted>
                      Your seat is decided by the quiz. Open it from the card above before it
                      closes.
                    </Muted>
                  )}
                {(detail.registration.status === "CONFIRMED" ||
                  detail.registration.status === "WAITLISTED" ||
                  detail.registration.status === "APPLIED") &&
                  detail.event.status !== "LIVE" &&
                  detail.event.status !== "COMPLETED" && (
                    <>
                      <Button
                        label={confirmWithdraw ? "Yes, give up my place" : "Give up my place"}
                        variant={confirmWithdraw ? "danger" : "ghost"}
                        disabled={busy}
                        onPress={() => {
                          if (confirmWithdraw) {
                            setConfirmWithdraw(false);
                            void withdraw();
                          } else setConfirmWithdraw(true);
                        }}
                        testID="withdraw"
                      />
                      {confirmWithdraw && (
                        <>
                          <Muted>
                            This cannot be undone from here, and your QR pass will stop working. Tap
                            again to confirm.
                          </Muted>
                          <Button
                            label="Keep my place"
                            variant="ghost"
                            onPress={() => setConfirmWithdraw(false)}
                          />
                        </>
                      )}
                    </>
                  )}
              </Card>
            ) : (
              <Card title="Join this event">
                {!detail.eligibility.eligible &&
                  detail.eligibility.reasons.map((r) => (
                    <Note
                      key={r}
                      tone="warn"
                      message={ELIGIBILITY_REASON_LABELS[r as EligibilityReason] ?? r}
                    />
                  ))}
                {!detail.eligibility.registrationOpen && (
                  <Muted>Registration is not open at this time.</Muted>
                )}
                {me?.user.accountType === "STAFF" ? (
                  <Muted>
                    Staff accounts organise and scan; participant registration is for students.
                  </Muted>
                ) : (
                  <Button
                    label="Register"
                    onPress={() => void register()}
                    busy={busy}
                    disabled={!detail.eligibility.canApply}
                    testID="register-event"
                  />
                )}
              </Card>
            )}
          </>
        )}
      </Screen>
    );

  const now = Date.now();
  const visible = events.filter(
    (e) =>
      filter === "all" ||
      (filter === "upcoming"
        ? new Date(e.endsAt).getTime() >= now && e.status !== "COMPLETED"
        : new Date(e.endsAt).getTime() < now || e.status === "COMPLETED"),
  );
  return (
    <Screen>
      <Title
        eyebrow={`Hi, ${me?.user.fullName.split(" ")[0] ?? "there"}`}
        title="What's happening on campus"
        subtitle="Find an event, claim a seat, keep the pass handy."
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Chip
          label="Discover"
          selected={tab === "discover"}
          onPress={() => {
            setTab("discover");
            setHasMore(false);
          }}
        />
        <Chip
          label="My registrations"
          selected={tab === "mine"}
          onPress={() => {
            setTab("mine");
            setHasMore(false);
          }}
        />
      </View>
      {tab === "discover" && (
        <Card>
          <View style={{ gap: 8 }}>
            <Field
              label="Search events"
              value={search}
              onChangeText={setSearch}
              placeholder="Event or club name"
            />
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Button
                label="Search"
                variant="ghost"
                onPress={() => setAppliedSearch(search.trim())}
              />
              {search ? (
                <Button
                  label="Clear"
                  variant="ghost"
                  onPress={() => {
                    setSearch("");
                    setAppliedSearch("");
                  }}
                />
              ) : null}
            </View>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            {(["all", "upcoming", "past"] as const).map((f) => (
              <Chip
                key={f}
                label={f === "all" ? "All" : f === "upcoming" ? "Upcoming" : "Past"}
                selected={filter === f}
                onPress={() => setFilter(f)}
              />
            ))}
          </ScrollView>
        </Card>
      )}
      <Note message={error} />
      {loading && (tab === "discover" ? events.length === 0 : registrations.length === 0) ? (
        <Loading />
      ) : (tab === "discover" ? visible.length === 0 : registrations.length === 0) ? (
        <Empty
          doodle="calendar"
          title={tab === "mine" ? "No registrations yet" : "No events found"}
          detail={
            tab === "mine"
              ? "Register for an event and it will appear here."
              : "Try another search or check back later."
          }
        />
      ) : tab === "discover" ? (
        visible.map((event) => {
          const start = new Date(event.startsAt);
          return (
            <Pressable
              key={event.id}
              accessibilityRole="button"
              onPress={() => setSelected(event.id)}
              style={({ pressed }) => pressed && { opacity: 0.88 }}
            >
              <Card>
                <View style={{ flexDirection: "row", gap: 13, alignItems: "flex-start" }}>
                  <View
                    style={{
                      width: 46,
                      height: 50,
                      borderRadius: 9,
                      borderWidth: 1,
                      borderColor: colors.line,
                      backgroundColor: colors.cardAlt,
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 1,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: fonts.display,
                        fontSize: 20,
                        fontWeight: "600",
                        color: colors.ink,
                        lineHeight: 22,
                      }}
                    >
                      {start.getDate()}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 7.5,
                        letterSpacing: 0.8,
                        textTransform: "uppercase",
                        color: colors.muted,
                      }}
                    >
                      {start.toLocaleString("en-GB", { month: "short" })}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 16.5,
                        fontWeight: "600",
                        color: colors.ink,
                        letterSpacing: -0.2,
                        lineHeight: 21,
                      }}
                    >
                      {event.title}
                    </Text>
                    <Muted>
                      {when(event.startsAt, tz)}
                      {" · "}
                      {event.venueSummary ?? "Venue to be announced"}
                    </Muted>
                  </View>
                  <AppIcon name="chevron" size={16} color={colors.muted} />
                </View>
                <Text
                  numberOfLines={2}
                  style={{ color: colors.muted, lineHeight: 19.5, fontSize: 13 }}
                >
                  {event.description}
                </Text>
                <View
                  style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}
                >
                  <Badge label={EVENT_TEMPLATE_LABELS[event.template]} tone="primary" />
                  <Badge label={statusLabel(event.status)} tone={eventTone(event.status)} />
                  <Text style={{ fontSize: 11, color: colors.muted, marginLeft: "auto" }}>
                    {event.capacity} seats
                  </Text>
                </View>
              </Card>
            </Pressable>
          );
        })
      ) : (
        registrations.map((r) => {
          const start = new Date(r.event.startsAt);
          return (
            <Pressable
              key={r.id}
              accessibilityRole="button"
              onPress={() => setSelected(r.eventId)}
              style={({ pressed }) => pressed && { opacity: 0.88 }}
            >
              <Card>
                <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
                  <View
                    style={{
                      width: 46,
                      height: 50,
                      borderRadius: 9,
                      borderWidth: 1,
                      borderColor: colors.line,
                      backgroundColor: colors.cardAlt,
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 1,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: fonts.display,
                        fontSize: 20,
                        fontWeight: "600",
                        color: colors.ink,
                        lineHeight: 22,
                      }}
                    >
                      {start.getDate()}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 7.5,
                        letterSpacing: 0.8,
                        textTransform: "uppercase",
                        color: colors.muted,
                      }}
                    >
                      {start.toLocaleString("en-GB", { month: "short" })}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 16,
                        fontWeight: "600",
                        color: colors.ink,
                        letterSpacing: -0.2,
                        lineHeight: 21,
                      }}
                    >
                      {r.event.title}
                    </Text>
                    <Muted>
                      {r.clubName} · {when(r.event.startsAt, tz)}
                    </Muted>
                  </View>
                  <Badge
                    label={statusLabel(r.status)}
                    tone={
                      r.status === "CONFIRMED"
                        ? "good"
                        : r.status === "REJECTED" || r.status === "CANCELLED"
                          ? "bad"
                          : "warn"
                    }
                  />
                </View>
                {r.queuePosition && <Muted>Waitlist position {r.queuePosition}</Muted>}
                {r.passRevokedAt && (
                  <Note message="Your pass was revoked. Contact the coordinator." />
                )}
              </Card>
            </Pressable>
          );
        })
      )}
      {hasMore && !loading && (
        <Button
          label="Load more"
          variant="ghost"
          onPress={() => void load(tab === "discover" ? events.length : registrations.length)}
        />
      )}
    </Screen>
  );
}
