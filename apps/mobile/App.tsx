import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AppIcon, type AppIconName, Logo } from "./components/icons";
import { Button, Note, Screen, Title, colors, fonts } from "./components/ui";
import { AuthScreen } from "./features/AuthScreen";
import { ComplaintsScreen } from "./features/ComplaintsScreen";
import { EventsScreen } from "./features/EventsScreen";
import { InboxScreen } from "./features/InboxScreen";
import { PassesScreen } from "./features/PassesScreen";
import { PendingScreen, ProfileScreen } from "./features/ProfileScreen";
import { QuizScreen } from "./features/QuizScreen";
import { ScannerScreen } from "./features/ScannerScreen";
import { complaintLocationId } from "./lib/format";
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
  // The tab id is the trigger: each switch replays the entrance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab is the trigger
  useEffect(() => {
    value.setValue(0);
    Animated.timing(value, {
      toValue: 1,
      duration: 260,
      useNativeDriver: true,
    }).start();
  }, [tab, value]);
  return {
    opacity: value,
    transform: [
      {
        translateY: value.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }),
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
              onOpenPasses={() => setTab("passes")}
              onOpenQuiz={(id, title) => setQuizTarget({ id, title })}
            />
          ))}
        {tab === "inbox" && <InboxScreen />}
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
                if (item.id !== "events") setQuizTarget(null);
              }}
              style={({ pressed }) => [s.tab, pressed && { opacity: 0.7 }]}
            >
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
              {active && !isScan && <View style={s.activeMark} />}
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
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
  nav: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: 6,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 2,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 2,
    gap: 3,
    minHeight: 50,
    justifyContent: "flex-end",
  },
  iconWrap: { height: 24, alignItems: "center", justifyContent: "center" },
  scanOrb: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: colors.dark,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -16,
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
  activeMark: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
});
