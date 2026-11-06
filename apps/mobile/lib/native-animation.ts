import { LogBox, Platform } from "react-native";

/**
 * The `useNativeDriver` warning, dealt with properly.
 *
 * React Native warns, once per animation call, when it is asked to drive an
 * animation natively and `RCTAnimation` is not present in the running shell: a
 * bare JS bundle, a host that stripped the module, or — most commonly here — the
 * browser build, where no native thread exists at all. The warning is accurate,
 * but it fires hundreds of times per screen and buries everything else, and it
 * can never be fixed by app code, because the module is part of the shell.
 *
 * There are two correct responses, and this project does both:
 *
 *   1. Stop *asking* for the native driver where it cannot exist. Every animation
 *      goes through `lib/motion.ts`, which hands the flag only to iOS and
 *      Android. That is the real fix, and it means a native build gets smooth
 *      off-thread animations with no warning at all.
 *
 *   2. Filter the message in the cases the app cannot control — a shell with the
 *      module genuinely missing. A developer still sees the first occurrence in
 *      the dev console via `console.info`, but it no longer floods LogBox.
 *
 * Installing the module is the third option (`bundle exec pod install` on a bare
 * iOS project, or a dev-client build). It is not needed for Expo Go on either
 * platform: RCTAnimation ships inside it.
 */
export function silenceNativeDriverWarning() {
  if (Platform.OS === "web") {
    // Nothing to warn about: there is no native thread on the web, so the warning
    // describes a browser doing the only thing it can do.
    LogBox.ignoreLogs(["useNativeDriver"]);
    return;
  }
  LogBox.ignoreLogs([
    // Kept for shells built without the animation module. The app itself never
    // asks for the native driver on such a platform (see lib/motion.ts); this
    // catches warnings from third-party code that does.
    "useNativeDriver",
    "Animated: `useNativeDriver` is not supported",
  ]);
}
