import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "./api";

/**
 * Push registration.
 *
 * The app never treats a push token as identity: it registers the token against
 * the signed-in account, and the API reassigns a token when a different account
 * signs in on the same phone. Failure here is non-fatal — the in-app inbox is
 * the source of truth, so a device without push still sees every announcement.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export type PushState = "unsupported" | "denied" | "unavailable" | "registered" | "failed";

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return Constants.easConfig?.projectId ?? extra?.eas?.projectId;
}

export async function registerForPush(): Promise<{ state: PushState; detail: string }> {
  // Simulators and browsers cannot receive Expo push tokens. Say so plainly
  // rather than reporting a success the user will never see.
  if (Platform.OS === "web")
    return { state: "unsupported", detail: "Push notifications need the installed app." };
  if (!Device.isDevice)
    return { state: "unsupported", detail: "Push notifications need a physical device." };

  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Event updates",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }
    if (!granted)
      return {
        state: "denied",
        detail:
          "Notifications are switched off for CampusOps. You will still see updates in the inbox.",
      };

    const id = projectId();
    if (!id)
      return {
        state: "unavailable",
        detail: "This build has no push project configured yet. The inbox still works.",
      };

    const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
    await api("/me/devices", {
      expoPushToken: token,
      platform: Platform.OS === "ios" ? "ios" : "android",
    });
    return { state: "registered", detail: "This phone will notify you about your events." };
  } catch (err) {
    return {
      state: "failed",
      detail: err instanceof Error ? err.message : "Could not enable notifications.",
    };
  }
}

export async function unregisterPush(): Promise<void> {
  if (Platform.OS === "web" || !Device.isDevice) return;
  try {
    const id = projectId();
    if (!id) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
    // Removal is a POST keyed by token, so it works even if this phone's row was
    // already reassigned to another account.
    await api("/me/devices/remove", { expoPushToken: token });
  } catch {
    // Signing out must not be blocked by a push cleanup failure.
  }
}
