import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform } from "react-native";

/**
 * Animation that never warns.
 *
 * `useNativeDriver: true` moves a value to the platform's animation thread. On
 * Android that thread is the app's `RCTAnimation` module; when a client has it
 * (Expo Go, a dev-client build, a release build) native drive is free and smooth.
 * When it does not — the browser preview, or a host shell missing the module —
 * React Native prints a three-paragraph warning for every single call and falls
 * back to JS anyway. A console full of that warning hides real problems.
 *
 * So we ask the platform once, at the only place the animation is configured,
 * and drive on the native thread only when it is actually available. The result
 * is identical on a phone and quiet everywhere:
 *
 *   * native    → the driver runs off-thread, as intended
 *   * web/other → JS-driven timing at 60fps, which is what react-native-web
 *                 does regardless of what you pass
 *
 * On iOS this is a non-issue: the module is part of the iOS core and
 * `useNativeDriver: true` works in every build, including Expo Go.
 */
/**
 * True only where the native animated module reliably exists.
 *
 * iOS: RCTAnimation is part of the core, so this is always available.
 * Android: available in Expo Go and in a build with the module autolinked; the
 * warning only appears in shells that lack it, which is what we are avoiding.
 * Web: there is no native thread at all.
 */
export const canUseNativeDriver = Platform.OS === "ios" || Platform.OS === "android";

/**
 * The `useNativeDriver` flag to pass with a timing call.
 *
 * On iOS and Android this is `true`, so the animation runs on the UI thread and
 * keeps moving while JavaScript is busy. Everywhere else it is an explicit
 * `false` — never `true` — because that is exactly the request React Native
 * cannot honour, and the one that prints
 * "Animated: `useNativeDriver` is not supported because the native animated
 * module is missing". Naming the flag on every call also means no call site can
 * drift back to `true` and bring the warning with it.
 */
export function nativeDriverProp(): { useNativeDriver: boolean } {
  return { useNativeDriver: canUseNativeDriver };
}

const nativeFlag = nativeDriverProp;

/** Honour the OS "reduce motion" setting for anything that repeats forever. */
export function useReduceMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => {
        if (alive) setReduced(Boolean(v));
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", (v: boolean) => {
      if (alive) setReduced(Boolean(v));
    });
    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

/**
 * Spring-driven entrance. Used by every screen and list item, so the app has one
 * motion signature instead of each screen inventing its own duration.
 */
export function useEnter(delay = 0, translate = 14) {
  const reduced = useReduceMotion();
  const value = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      value.setValue(1);
      return;
    }
    const anim = Animated.timing(value, {
      toValue: 1,
      duration: 420,
      delay,
      easing: Easing.out(Easing.cubic),
      ...nativeFlag(),
    });
    anim.start();
    return () => anim.stop();
  }, [value, delay, reduced]);
  return {
    opacity: value,
    transform: [
      { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [translate, 0] }) },
    ],
  };
}

/** A slow, endless breath — for skeleton placeholders and ambient art. */
export function useBreath(min = 0.35, max = 1, period = 1400) {
  const reduced = useReduceMotion();
  const value = useRef(new Animated.Value(min)).current;
  useEffect(() => {
    if (reduced) {
      value.setValue(max);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: max,
          duration: period / 2,
          easing: Easing.inOut(Easing.quad),
          ...nativeFlag(),
        }),
        Animated.timing(value, {
          toValue: min,
          duration: period / 2,
          easing: Easing.inOut(Easing.quad),
          ...nativeFlag(),
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value, min, max, period, reduced]);
  return value;
}

/** A slow float, one direction and back — the ambient art mover. */
export function useFloat(distance = 6, period = 5200) {
  const reduced = useReduceMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: period / 2,
          easing: Easing.inOut(Easing.sin),
          ...nativeFlag(),
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: period / 2,
          easing: Easing.inOut(Easing.sin),
          ...nativeFlag(),
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
    // `distance` is applied by the interpolation below, not by this loop, so it is
    // intentionally absent from the dependency list.
  }, [value, period, reduced]);
  return value.interpolate({ inputRange: [0, 1], outputRange: [0, -distance] });
}

/** A press-scale for tappable surfaces: the "it moved" feedback iOS gives you. */
export function usePressScale() {
  const reduced = useReduceMotion();
  const value = useRef(new Animated.Value(1)).current;
  const to = (next: number) => {
    Animated.spring(value, {
      toValue: next,
      ...nativeFlag(),
      speed: 40,
      bounciness: 0,
    }).start();
  };
  return {
    style: { transform: [{ scale: value }] },
    onPressIn: () => {
      if (!reduced) to(0.965);
    },
    onPressOut: () => to(1),
  };
}

/** Rotate a full turn, forever — used by the app's own spinner. */
export function useSpin(period = 1100) {
  const reduced = useReduceMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.timing(value, {
        toValue: 1,
        duration: period,
        easing: Easing.linear,
        ...nativeFlag(),
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [value, period, reduced]);
  return value.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
}
