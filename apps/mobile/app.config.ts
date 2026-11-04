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
