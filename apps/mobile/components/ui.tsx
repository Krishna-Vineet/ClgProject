import type { PropsWithChildren, ReactNode } from "react";
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useBreath, useEnter, useFloat, usePressScale, useSpin } from "../lib/motion";
import { type Doodle, Sketch } from "./Sketch";

/**
 * CampusOps mobile design tokens. Same "Ledger" language as the console:
 * warm paper, ink type, hairline rules, one seal-red accent.
 */
export const colors = {
  bg: "#f3f0e8",
  card: "#fbf9f3",
  cardAlt: "#f0ece1",
  ink: "#17160f",
  inkSoft: "#3a382d",
  // 4.99:1 on the paper background (was #726f61 at 4.43:1, below AA).
  muted: "#676454",
  line: "#e0dbcc",
  lineStrong: "#cec7b4",
  primary: "#b0472b",
  primaryInk: "#8e3620",
  soft: "#f5e3d9",
  dark: "#191811",
  cream: "#f6f1e5",
  good: "#2f6a4c",
  goodBg: "#e7f0e9",
  bad: "#a63a2c",
  badBg: "#f8e4df",
  warn: "#8a6216",
  warnBg: "#f7eed8",
  info: "#2b5875",
  infoBg: "#e5eef4",
  // A single translucent scrim colour, so "raised" is a property of the system
  // rather than a different shadow literal in every file.
  shadow: "rgba(23,22,15,0.10)",
  scrim: "rgba(23,22,15,0.28)",
};

/** The rounded-corner family. One scale, used everywhere. */
export const radii = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 };

/** "Apple-like" means a soft, low-contrast lift — not a drop shadow. */
export const elevation = {
  card: Platform.select({
    ios: {
      shadowColor: "#17160f",
      shadowOpacity: 0.06,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
    },
    android: { elevation: 2 },
    default: { boxShadow: "0 10px 26px -18px rgba(23,22,15,0.28)" },
  }) as object,
  floating: Platform.select({
    ios: {
      shadowColor: "#17160f",
      shadowOpacity: 0.14,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 10 },
    },
    android: { elevation: 8 },
    default: { boxShadow: "0 18px 44px -22px rgba(23,22,15,0.38)" },
  }) as object,
};

export const fonts = {
  display: Platform.select({
    ios: "Palatino",
    android: "serif",
    default: "Fraunces, 'Iowan Old Style', Palatino, Georgia, serif",
  }) as string,
  sans: Platform.select({
    ios: "System",
    android: "sans-serif",
    default: "Inter, -apple-system, 'Segoe UI', Roboto, sans-serif",
  }) as string,
  mono: Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "ui-monospace, Menlo, Consolas, monospace",
  }) as string,
};

/**
 * Ambient artwork behind every screen.
 *
 * Two faint doodles that drift a few pixels, at 12% opacity. It is the same
 * drawing on every tab — a campus and a wave — so the app has a consistent
 * backdrop rather than a different decoration per screen, and because it sits at
 * z-index 0 under the content it never competes with the type.
 */
function Ambient() {
  const drift = useFloat(7, 6400);
  const drift2 = useFloat(10, 8200);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={{ position: "absolute", top: -18, right: -30, transform: [{ translateY: drift }] }}
      >
        <Sketch name="campus" size={210} faint />
      </Animated.View>
      <Animated.View
        style={{ position: "absolute", bottom: 40, left: -46, transform: [{ translateY: drift2 }] }}
      >
        <Sketch name="wave" size={240} faint />
      </Animated.View>
      <Animated.View
        style={{
          position: "absolute",
          top: "46%",
          right: -54,
          transform: [{ translateY: drift2 }],
        }}
      >
        <Sketch name="sparkle" size={150} faint />
      </Animated.View>
      {/* Skew topology: the backdrop is cut by a wide, tilted bed rather than
          sitting on a rectangle grid. Two bands at opposite angles give every
          screen a diagonal composition while staying fully behind the type. */}
      <Animated.View
        style={[s.skewBand, { top: -140, transform: [{ skewY: "-4deg" }, { translateY: drift }] }]}
      />
      <Animated.View
        style={[
          s.skewBandSoft,
          { bottom: -90, transform: [{ skewY: "3deg" }, { translateY: drift2 }] },
        ]}
      />
    </View>
  );
}

export function Screen({
  children,
  scroll = true,
  bottomGap = 120,
  ambient = true,
}: PropsWithChildren<{ scroll?: boolean; bottomGap?: number; ambient?: boolean }>) {
  return (
    <View style={s.page}>
      {ambient ? <Ambient /> : null}
      {scroll ? (
        <ScrollView
          style={s.page}
          contentContainerStyle={[s.content, { paddingBottom: bottomGap }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[s.page, s.content]}>{children}</View>
      )}
    </View>
  );
}

export function Card({
  children,
  title,
  action,
  subtitle,
  tone,
  index = 0,
}: PropsWithChildren<{
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  tone?: "paper" | "ink";
  /** Position in the screen, used only to stagger the entrance. */
  index?: number;
}>) {
  const dark = tone === "ink";
  const enter = useEnter(Math.min(index, 6) * 55);
  return (
    <Animated.View style={[s.card, dark && s.cardInk, enter]}>
      {(title || action || subtitle) && (
        <View style={s.cardHead}>
          <View style={{ flex: 1, gap: 2 }}>
            {title ? (
              <Text style={[s.cardTitle, dark && { color: colors.cream }]}>{title}</Text>
            ) : null}
            {subtitle ? (
              <Text style={[s.muted, dark && { color: "rgba(246,241,229,0.6)" }]}>{subtitle}</Text>
            ) : null}
          </View>
          {action}
        </View>
      )}
      {children}
    </Animated.View>
  );
}

export function Title({
  eyebrow,
  title,
  subtitle,
}: { eyebrow?: string; title: string; subtitle?: string }) {
  return (
    <View style={s.titleBlock}>
      {eyebrow && (
        <View style={s.eyebrowRow}>
          <View style={s.eyebrowMark} />
          <Text style={s.eyebrow}>{eyebrow}</Text>
        </View>
      )}
      <Text style={s.title} accessibilityRole="header">
        {title}
      </Text>
      <View style={s.titleRule}>
        <AnimatedRule />
        <AnimatedRule delay={120} small />
      </View>
      {subtitle && <Text style={s.muted}>{subtitle}</Text>}
    </View>
  );
}

/**
 * A hairline that draws itself in under the page title — tilted, not level.
 *
 * The skew is the cheapest way to break the "stack of rectangles" look: the eye
 * reads the page as a sheet with a cut edge instead of a table of boxes. Two
 * rules at different angles (one long, one short) read as a drawn mark rather
 * than a border.
 */
function AnimatedRule({ delay = 40, small = false }: { delay?: number; small?: boolean }) {
  const enter = useEnter(delay, 0);
  return <Animated.View style={[s.titleRuleBar, small && s.titleRuleBarSmall, enter]} />;
}

export function SectionLabel({ children }: PropsWithChildren) {
  return <Text style={s.sectionLabel}>{children}</Text>;
}

export function Muted({ children }: PropsWithChildren) {
  return <Text style={s.muted}>{children}</Text>;
}

/**
 * A pressable that answers the finger.
 *
 * The old button only changed opacity. A spring scale reads as physical, which is
 * the single biggest difference between a web form and a native one. The scale
 * runs on the animation thread, so it does not stutter while the JS thread is
 * busy parsing a response.
 */
export function Button({
  label,
  onPress,
  disabled,
  variant = "primary",
  busy,
  testID,
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger";
  busy?: boolean;
  testID?: string;
  icon?: Doodle;
}) {
  const inactive = disabled || busy;
  const press = usePressScale();
  const textColor =
    variant === "primary" ? colors.cream : variant === "danger" ? colors.bad : colors.ink;
  return (
    <Animated.View style={[press.style, inactive && s.disabled, s.buttonWrap]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        testID={testID}
        accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        disabled={inactive}
        style={[
          s.button,
          variant === "ghost" && s.ghost,
          variant === "danger" && s.danger,
          variant === "primary" && elevation.card,
        ]}
      >
        {busy ? (
          <Spinner color={textColor} size={16} />
        ) : (
          <>
            {icon ? <Sketch name={icon} size={17} color={textColor} strokeWidth={2.4} /> : null}
            <Text style={[s.buttonText, { color: textColor }]} numberOfLines={1}>
              {label}
            </Text>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

/**
 * The app's own spinner.
 *
 * `ActivityIndicator` is a platform view: it looks different on iOS, Android and
 * the browser, and on the web it is a CSS ring we do not control. Two Views
 * rotating at 1100 ms looks the same everywhere and inherits the text colour.
 */
export function Spinner({ color = colors.ink, size = 16 }: { color?: string; size?: number }) {
  const spin = useSpin(1000);
  return (
    <Animated.View
      accessibilityLabel="Working"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: Math.max(1.6, size / 9),
        borderColor: "rgba(0,0,0,0.14)",
        borderTopColor: color,
        transform: [{ rotate: spin }],
      }}
    />
  );
}

/**
 * A full-screen dim while the whole screen is working (submitting, scanning,
 * minting a code). It blocks touches, so a double-tap cannot replay the action,
 * and it dims rather than blanks: the student keeps their place.
 */
export function ScreenOverlay({ visible, label }: { visible: boolean; label?: string }) {
  const enter = useEnter(0, 0);
  if (!visible) return null;
  return (
    <Animated.View style={[s.overlay, enter]} pointerEvents="auto" accessibilityViewIsModal>
      <View style={[s.overlayCard, elevation.floating]}>
        <Sketch name="sparkle" size={54} />
        <Spinner size={20} />
        {label ? <Text style={s.sectionLabel}>{label}</Text> : null}
      </View>
    </Animated.View>
  );
}

/** A pull-down-to-refresh style indicator for a screen's first load. */
export function ScreenLoader({ label = "Loading…" }: { label?: string }) {
  const enter = useEnter();
  return (
    <Animated.View
      style={[s.screenLoader, enter]}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
    >
      <Sketch name="clock" size={86} faint={false} />
      <Spinner size={22} />
      <Text style={s.sectionLabel}>{label}</Text>
    </Animated.View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  multiline,
  maxLength,
  hint,
  autoCapitalize = "none",
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string | undefined;
  secureTextEntry?: boolean | undefined;
  keyboardType?: "default" | "email-address" | "numeric" | "phone-pad" | undefined;
  multiline?: boolean | undefined;
  maxLength?: number | undefined;
  hint?: string | undefined;
  autoCapitalize?: "none" | "sentences" | undefined;
  testID?: string | undefined;
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#a39d8c"
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        multiline={multiline}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        style={[s.input, multiline && s.textarea]}
      />
      {hint && <Text style={s.hint}>{hint}</Text>}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: { label: string; selected?: boolean; onPress: () => void }) {
  const press = usePressScale();
  return (
    <Animated.View style={press.style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: Boolean(selected) }}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[s.chip, selected && s.chipSelected]}
      >
        <Text style={[s.chipText, selected && { color: colors.cream }]} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * A real checkbox: role="checkbox", a hit target large enough to tap, and the
 * label inside the pressable so the text is part of the control.
 */
export function Checkbox({
  checked,
  onToggle,
  label,
  hint,
  testID,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onToggle}
      testID={testID}
      style={({ pressed }) => [s.checkbox, pressed && { opacity: 0.8 }]}
    >
      <View style={[s.checkboxBox, checked && s.checkboxBoxOn]}>
        {checked ? <Text style={s.checkboxTick}>✓</Text> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.checkboxLabel}>{label}</Text>
        {hint ? <Text style={s.checkboxHint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

const TONES = {
  neutral: { fg: colors.muted, bg: "#efece2", border: colors.line },
  good: { fg: colors.good, bg: colors.goodBg, border: "rgba(47,106,76,0.28)" },
  bad: { fg: colors.bad, bg: colors.badBg, border: "rgba(166,58,44,0.26)" },
  warn: { fg: colors.warn, bg: colors.warnBg, border: "rgba(138,98,22,0.26)" },
  primary: { fg: colors.primaryInk, bg: colors.soft, border: "rgba(176,71,43,0.24)" },
} as const;

export function Badge({ label, tone = "neutral" }: { label: string; tone?: keyof typeof TONES }) {
  const t = TONES[tone];
  return (
    <View style={[s.badge, { backgroundColor: t.bg, borderColor: t.border }]}>
      <View style={[s.badgeDot, { backgroundColor: t.fg }]} />
      <Text style={[s.badgeText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

export function Note({
  message,
  tone = "bad",
}: { message: string | null; tone?: "bad" | "good" | "warn" | "neutral" }) {
  if (!message) return null;
  const t = TONES[tone];
  return (
    <View
      accessibilityRole="alert"
      style={[s.note, { backgroundColor: t.bg, borderColor: t.border }]}
    >
      <View style={[s.noteMark, { backgroundColor: t.fg }]} />
      <Text style={{ color: t.fg, lineHeight: 20, flex: 1, fontSize: 13 }}>{message}</Text>
    </View>
  );
}

export function Skeleton({
  height = 14,
  width = "100%",
  radius = 6,
}: { height?: number; width?: number | `${number}%`; radius?: number }) {
  const opacity = useBreath(0.4, 1);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height, width, borderRadius: radius, backgroundColor: colors.cardAlt, opacity }}
    />
  );
}

export function Loading({
  label = "Loading…",
  cards = 2,
  doodle,
}: { label?: string; cards?: number; doodle?: Doodle }) {
  return (
    <View style={s.loading} accessibilityLabel={label} accessibilityRole="progressbar">
      <View style={s.loadingHead}>
        <Sketch name={doodle ?? "clock"} size={44} faint />
        <Spinner size={15} />
        <Text style={s.sectionLabel}>{label}</Text>
      </View>
      <Skeleton height={16} width="46%" />
      {Array.from({ length: cards }, (_, i) => `sk-${i}`).map((id) => (
        <Skeleton key={id} height={72} radius={radii.md} />
      ))}
    </View>
  );
}

export function Empty({
  title,
  detail,
  doodle = "sparkle",
}: { title: string; detail?: string; doodle?: Doodle }) {
  const enter = useEnter();
  return (
    <Animated.View style={[s.empty, enter]}>
      <Sketch name={doodle} size={64} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={s.cardTitle}>{title}</Text>
        {detail && <Text style={s.muted}>{detail}</Text>}
      </View>
    </Animated.View>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.detailRow}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.detailValue}>{value}</Text>
    </View>
  );
}

export function Divider() {
  return <View style={s.divider} />;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: {
    padding: 18,
    paddingBottom: 120,
    gap: 14,
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
  },
  titleBlock: { gap: 6, marginBottom: 6, paddingTop: 10 },
  titleRule: { height: 10, marginTop: 2, flexDirection: "row", alignItems: "center", gap: 6 },
  titleRuleBar: {
    height: 2.5,
    width: 68,
    borderRadius: 2,
    backgroundColor: colors.primary,
    transform: [{ skewX: "-24deg" }],
  },
  titleRuleBarSmall: {
    width: 16,
    height: 2,
    backgroundColor: colors.lineStrong,
  },
  eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  eyebrowMark: { width: 5, height: 5, borderRadius: 1, backgroundColor: colors.primary },
  eyebrow: {
    color: colors.primaryInk,
    fontSize: 9.5,
    fontFamily: fonts.mono,
    fontWeight: "600",
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  title: {
    color: colors.ink,
    fontSize: 34,
    fontFamily: fonts.display,
    fontWeight: "500",
    letterSpacing: -0.6,
    lineHeight: 35,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 18,
    gap: 12,
  },
  cardInk: { backgroundColor: colors.dark, borderColor: colors.dark },
  cardHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
    letterSpacing: -0.1,
  },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 19.5 },
  sectionLabel: {
    color: colors.muted,
    fontSize: 9.5,
    fontFamily: fonts.mono,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  button: {
    minHeight: 50,
    borderRadius: radii.md,
    backgroundColor: colors.dark,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: colors.dark,
    flexDirection: "row",
    gap: 8,
  },
  ghost: { backgroundColor: "transparent", borderColor: colors.lineStrong },
  danger: { backgroundColor: "transparent", borderColor: "rgba(166,58,44,0.4)" },
  buttonText: { fontWeight: "600", fontSize: 14, textAlign: "center", letterSpacing: 0.1 },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.82, transform: [{ scale: 0.995 }] },
  field: { gap: 5 },
  label: { color: colors.inkSoft, fontWeight: "600", fontSize: 12 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    color: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    minHeight: 46,
  },
  textarea: { minHeight: 104, textAlignVertical: "top" },
  hint: { color: colors.muted, fontSize: 11.5, lineHeight: 17 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radii.pill,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.lineStrong,
    maxWidth: 260,
  },
  chipSelected: { backgroundColor: colors.dark, borderColor: colors.dark },
  chipText: { color: colors.inkSoft, fontWeight: "600", fontSize: 12.5 },
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3.5,
  },
  badgeDot: { width: 4, height: 4, borderRadius: 2 },
  badgeText: {
    fontSize: 9.5,
    fontWeight: "700",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    fontFamily: fonts.mono,
  },
  note: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 11,
    flexDirection: "row",
    gap: 9,
    alignItems: "flex-start",
  },
  noteMark: { width: 3, borderRadius: 2, alignSelf: "stretch", minHeight: 16, marginTop: 2 },
  loading: { gap: 10, paddingVertical: 8 },
  loadingHead: { flexDirection: "row", alignItems: "center", gap: 9 },
  screenLoader: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 48,
  },
  buttonWrap: { alignSelf: "stretch" },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.scrim,
    zIndex: 40,
  },
  overlayCard: {
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 26,
    paddingVertical: 22,
    borderRadius: radii.xl,
    backgroundColor: colors.card,
  },
  empty: {
    flexDirection: "row",
    gap: 14,
    alignItems: "center",
    borderRadius: radii.lg,
    padding: 18,
    backgroundColor: colors.cardAlt,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 14,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowLabel: { color: colors.muted, fontSize: 12, flexShrink: 1 },
  detailValue: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
  },
  divider: { height: 1, backgroundColor: colors.line },
  /* The two tilted beds behind the content. Kept very low contrast so the app
     still reads as paper: they are a change of angle, not a change of colour. */
  skewBand: {
    position: "absolute",
    left: "-30%",
    right: "-30%",
    height: 340,
    backgroundColor: "rgba(176,71,43,0.045)",
  },
  skewBandSoft: {
    position: "absolute",
    left: "-30%",
    right: "-30%",
    height: 300,
    backgroundColor: "rgba(23,22,15,0.035)",
  },
  checkbox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 8,
  },
  checkboxBox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.lineStrong,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxBoxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkboxTick: { color: colors.cream, fontSize: 14, lineHeight: 18, fontWeight: "700" },
  checkboxLabel: { color: colors.ink, fontSize: 13, lineHeight: 19 },
  checkboxHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 3 },
});
