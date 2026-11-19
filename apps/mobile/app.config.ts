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
  /**
   * iOS and Android are both first-class targets, and both are configured here
   * rather than in an `app.json` that Android-only projects tend to leave thin.
   *
   *   buildNumber/versionCode  required before any store upload; without them
   *                            EAS rejects the build with no useful explanation
   *   infoPlist                the camera string is what iOS shows in the
   *                            permission sheet — an empty one gets the app
   *                            rejected, and a vague one confuses the student
   *   ITSAppUsesNonExemptEncryption: false  the app only uses HTTPS and the
   *                            keychain, which are exempt; declaring it avoids a
   *                            compliance question on every submission
   */
  ios: {
    supportsTablet: true,
    bundleIdentifier: "local.campusops.demo",
    buildNumber: "1",
    infoPlist: {
      NSCameraUsageDescription:
        "CampusOps uses the camera to scan event passes at the gate and to report an issue at a campus location.",
      ITSAppUsesNonExemptEncryption: false,
      NSPhotoLibraryUsageDescription:
        "CampusOps needs photo access only when you choose a picture of your student ID for verification.",
    },
  },
  android: {
    package: "local.campusops.demo",
    versionCode: 1,
    // New Architecture is the default on RN 0.88; stated so a future downgrade
    // is a deliberate edit rather than a surprise at build time.
    softwareKeyboardLayoutMode: "resize",
    adaptiveIcon: { backgroundColor: "#f3f0e8" },
  },
  /**
   * Both platforms, explicitly. `platforms` is what `expo start` and
   * `expo export` read; leaving it out means "all supported", which is right
   * today but does not document that iOS is a supported target.
   */
  platforms: ["ios", "android", "web"],
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
