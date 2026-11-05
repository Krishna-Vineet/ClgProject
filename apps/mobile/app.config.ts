import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * EXPO_PUBLIC_API_URL is the absolute origin of the API for a physical phone,
 * e.g. https://campusops-api.onrender.com (no /api/v1 suffix). The browser
 * preview leaves it unset and uses Metro's same-origin /api proxy instead.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "CampusOps",
  slug: "campusops",
  version: "0.7.0",
  orientation: "portrait",
  scheme: "campusops",
  /**
   * The student app ships one theme: warm paper, on purpose. A light-only design
   * must say so, or iOS renders system surfaces (alerts, keyboards, share sheets)
   * dark against our light cards and the result is worse than either theme done
   * properly. Declaring "light" keeps the native chrome consistent with the
   * screens; a real dark palette is a separate piece of work, tracked in
   * docs/mobile.md rather than half-implemented here.
   */
  userInterfaceStyle: "light",
  ios: { supportsTablet: true, bundleIdentifier: "local.campusops.demo" },
  android: { package: "local.campusops.demo" },
  web: { bundler: "metro" },
  plugins: [
    [
      "expo-camera",
      {
        cameraPermission:
          "CampusOps uses the camera to scan event passes and report issues at event locations.",
        recordAudioAndroid: false,
      },
    ],
    "expo-secure-store",
    // Push is opt-in at runtime; the plugin only wires the native capability.
    // No icon/colour is set so the app keeps the OS default notification look.
    "expo-notifications",
  ],
  extra: { apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "" },
});
