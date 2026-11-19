import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AppIcon, type AppIconName, Logo } from "./components/icons";
import { Button, Note, Screen, Title, colors, elevation, fonts } from "./components/ui";
import { AuthScreen } from "./features/AuthScreen";
import { ComplaintsScreen } from "./features/ComplaintsScreen";
import { EventsScreen } from "./features/EventsScreen";
import { InboxScreen } from "./features/InboxScreen";
import { PassesScreen } from "./features/PassesScreen";
import { PendingScreen, ProfileScreen } from "./features/ProfileScreen";
import { QuizScreen } from "./features/QuizScreen";
import { ScannerScreen } from "./features/ScannerScreen";
import { complaintLocationId } from "./lib/format";
import { nativeDriverProp } from "./lib/motion";
import { SessionProvider, useSession } from "./lib/session";

type Tab = "events" | "inbox" | "passes" | "scan" | "issues" | "profile";
const tabs: Array<{ id: Tab; label: string; icon: AppIconName }> = [
  { id: "events", label: "Events", icon: "events" },
  { id: "passes", label: "Passes", icon: "passes" },
  { id: "scan", label: "Scan", icon: "scan" },
  { id: "inbox", label: "Updates", icon: "inbox" },
  { id: "issues", label: "Help", icon: "help" },
  { id: "profile", label: "You", icon: "user" },
];

function useScreenIn(tab: Tab) {
  const value = useRef(new Animated.Value(1)).current;
  // The tab id is the trigger: each switch replays the entrance. The driver is
  // chosen by lib/motion, which is the only place that decides whether the
  // native animation module can be used — otherwise every one of these calls
  // prints React Native's three-paragraph fallback warning in Expo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab is the trigger
  useEffect(() => {
    value.setValue(0);
    Animated.timing(value, {
      toValue: 1,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      ...nativeDriverProp(),
    }).start();
  }, [tab, value]);
  return {
    opacity: value,
    transform: [
      {
        translateY: value.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }),
      },
    ],
  };
}

function Shell() {
  const { me, config, bootError, retryBoot } = useSession();
  const isOrganiser = Boolean(me?.clubMemberships.length);
  const [tab, setTab] = useState<Tab>("events");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [quizTarget, setQuizTarget] = useState<{ id: string; title: string } | null>(null);
  // Opening an event from an announcement lands on the event itself, not just on
  // the events tab: a venue change is useless if the student has to search again.
  const [eventTarget, setEventTarget] = useState<string | null>(null);
  const screenStyle = useScreenIn(tab);

  useEffect(() => {
    function receive(url: string | null) {
      if (!url) return;
      const id = complaintLocationId(url, config?.complaintQrBase ?? "");
      if (id) {
        setLocationId(id);
        setTab("issues");
      }
    }
    void Linking.getInitialURL().then(receive);
    const sub = Linking.addEventListener("url", ({ url }) => receive(url));
    return () => sub.remove();
  }, [config?.complaintQrBase]);

  if (bootError)
    return (
      <Screen>
        <Title
          eyebrow="CampusOps"
          title="Can't reach the campus"
          subtitle="The app needs a connection to the CampusOps service."
        />
        <Note message={bootError} />
        <Button label="Try again" onPress={retryBoot} />
      </Screen>
    );
  if (!me) return <AuthScreen />;
  if (me.user.status !== "ACTIVE") return <PendingScreen />;

  function openComplaint(id: string) {
    setLocationId(id);
    setTab("issues");
  }

  const initials = me.user.fullName
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <View style={s.shell}>
      <View style={s.header}>
        <View style={s.brand}>
          <Logo size={26} />
          <Text style={s.brandWord}>CampusOps</Text>
        </View>
        <View style={s.headerRight}>
          {Platform.OS === "web" && <Text style={s.preview}>Preview</Text>}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open your profile"
            onPress={() => setTab("profile")}
            style={s.avatar}
          >
            <Text style={s.avatarText}>{initials}</Text>
          </Pressable>
        </View>
      </View>

      <Animated.View style={[s.body, screenStyle]}>
        {tab === "events" &&
          (quizTarget ? (
            <QuizScreen
              eventId={quizTarget.id}
              eventTitle={quizTarget.title}
              onClose={() => setQuizTarget(null)}
            />
          ) : (
            <EventsScreen
              openEventId={eventTarget}
              onOpenConsumed={() => setEventTarget(null)}
              onOpenPasses={() => setTab("passes")}
              onOpenQuiz={(id, title) => setQuizTarget({ id, title })}
            />
          ))}
        {tab === "inbox" && (
          <InboxScreen
            onOpenEvent={(eventId) => {
              setQuizTarget(null);
              setEventTarget(eventId);
              setTab("events");
            }}
          />
        )}
        {tab === "passes" && <PassesScreen />}
        {tab === "scan" && <ScannerScreen onComplaint={openComplaint} />}
        {tab === "issues" && (
          <ComplaintsScreen
            locationId={locationId}
            onLocation={setLocationId}
            onScan={() => setTab("scan")}
          />
        )}
        {tab === "profile" && (
          <ProfileScreen
            onComplaints={() => {
              setLocationId(null);
              setTab("issues");
            }}
          />
        )}
      </Animated.View>

      <View style={s.nav} accessibilityRole="tablist">
        {tabs.map((item) => {
          const active = tab === item.id;
          // The centre Scan orb is the organisers' primary action. A student has
          // no events to scan, but still reads complaint posters with the same
          // camera, so the tab stays as an ordinary item instead of being the
          // loudest thing on their screen — and instead of being removed, which
          // would strand the "scan a location QR" entry point.
          const isScan = item.id === "scan" && isOrganiser;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: active }}
              testID={`tab-${item.id}`}
              onPress={() => {
                setTab(item.id);
                if (item.id !== "issues") setLocationId(null);
                if (item.id !== "events") {
                  setQuizTarget(null);
                  setEventTarget(null);
                }
              }}
              style={s.tab}
            >
              {active && !isScan ? <View style={s.tabPill} /> : null}
              <View style={isScan ? [s.scanOrb, active && s.scanOrbActive] : s.iconWrap}>
                <AppIcon
                  name={item.icon}
                  size={isScan ? 22 : 20}
                  color={isScan ? colors.cream : active ? colors.primary : colors.muted}
                  strokeWidth={active ? 2 : 1.7}
                />
              </View>
              <Text style={[s.label, active && s.activeLabel]} numberOfLines={1}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe} edges={["top", "left", "right", "bottom"]}>
        <StatusBar style="dark" />
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  shell: { flex: 1, width: "100%", maxWidth: 760, alignSelf: "center" },
  /* No rule under the header: the brand floats on the paper with the ambient
     doodles behind it, which is what makes the top of the app feel like a sheet
     rather than a toolbar. */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: colors.bg,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 9 },
  brandWord: {
    fontFamily: fonts.display,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: -0.4,
    color: colors.ink,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  preview: {
    fontFamily: fonts.mono,
    fontSize: 8.5,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: colors.muted,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  avatar: {
    width: 31,
    height: 31,
    borderRadius: 8,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: "rgba(176,71,43,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    fontWeight: "600",
    color: colors.primaryInk,
  },
  body: { flex: 1 },
  /* A floating bar, not a strip glued to the bottom edge: detached, fully
     rounded, with a soft lift. This is the one place the app most looks like a
     website if it gets it wrong. */
  nav: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderRadius: 26,
    paddingHorizontal: 8,
    paddingTop: 9,
    paddingBottom: 9,
    gap: 2,
    marginHorizontal: 14,
    marginBottom: 10,
    ...elevation.floating,
  },
  tab: {
    position: "relative",
    flex: 1,
    alignItems: "center",
    paddingVertical: 2,
    gap: 3,
    minHeight: 50,
    justifyContent: "flex-end",
  },
  /* The selection is a soft capsule behind the icon, the way a segmented
     control reads, instead of a dot that appears and disappears. */
  tabPill: {
    position: "absolute",
    top: -2,
    width: 46,
    height: 34,
    borderRadius: 12,
    backgroundColor: colors.soft,
  },
  iconWrap: { height: 24, alignItems: "center", justifyContent: "center" },
  scanOrb: {
    width: 44,
    height: 44,
    borderRadius: 16,
    backgroundColor: colors.dark,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -20,
    borderWidth: 3,
    borderColor: colors.card,
  },
  scanOrbActive: { backgroundColor: colors.primary, borderColor: colors.soft },
  label: {
    fontSize: 9.5,
    fontWeight: "600",
    color: colors.muted,
    letterSpacing: 0.1,
    fontFamily: fonts.sans,
  },
  activeLabel: { color: colors.ink },
});
