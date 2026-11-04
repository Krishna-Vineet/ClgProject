import type { PropsWithChildren, ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

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
  muted: "#726f61",
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

export function Screen({
  children,
  scroll = true,
  bottomGap = 120,
}: PropsWithChildren<{ scroll?: boolean; bottomGap?: number }>) {
  return scroll ? (
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
  );
}

export function Card({
  children,
  title,
  action,
  subtitle,
  tone,
}: PropsWithChildren<{
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  tone?: "paper" | "ink";
}>) {
  const dark = tone === "ink";
  return (
    <View style={[s.card, dark && s.cardInk]}>
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
    </View>
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
      {subtitle && <Text style={s.muted}>{subtitle}</Text>}
    </View>
  );
}

export function SectionLabel({ children }: PropsWithChildren) {
  return <Text style={s.sectionLabel}>{children}</Text>;
}

export function Muted({ children }: PropsWithChildren) {
  return <Text style={s.muted}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  disabled,
  variant = "primary",
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger";
  busy?: boolean;
  testID?: string;
}) {
  const inactive = disabled || busy;
  const textColor =
    variant === "primary" ? colors.cream : variant === "danger" ? colors.bad : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        s.button,
        variant === "ghost" && s.ghost,
        variant === "danger" && s.danger,
        inactive && s.disabled,
        pressed && !inactive && s.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={textColor} size="small" />
      ) : (
        <Text style={[s.buttonText, { color: textColor }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={({ pressed }) => [s.chip, selected && s.chipSelected, pressed && { opacity: 0.85 }]}
    >
      <Text style={[s.chipText, selected && { color: colors.cream }]} numberOfLines={1}>
        {label}
      </Text>
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

function usePulse() {
  const value = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 850, useNativeDriver: true }),
        Animated.timing(value, { toValue: 0.45, duration: 850, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value]);
  return value;
}

export function Skeleton({
  height = 14,
  width = "100%",
  radius = 6,
}: { height?: number; width?: number | `${number}%`; radius?: number }) {
  const opacity = usePulse();
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height, width, borderRadius: radius, backgroundColor: colors.cardAlt, opacity }}
    />
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <View style={s.loading} accessibilityLabel={label} accessibilityRole="progressbar">
      <Text style={s.sectionLabel}>{label}</Text>
      <Skeleton height={16} width="46%" />
      <Skeleton height={72} radius={12} />
      <Skeleton height={72} radius={12} />
    </View>
  );
}

export function Empty({
  title,
  detail,
  icon,
}: { title: string; detail?: string; icon?: ReactNode }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyMark}>{icon ?? <View style={s.emptyDot} />}</View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={s.cardTitle}>{title}</Text>
        {detail && <Text style={s.muted}>{detail}</Text>}
      </View>
    </View>
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
  titleBlock: { gap: 6, marginBottom: 4, paddingTop: 10 },
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
    fontSize: 31,
    fontFamily: fonts.display,
    fontWeight: "500",
    letterSpacing: -0.6,
    lineHeight: 35,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 11,
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
    minHeight: 46,
    borderRadius: 9,
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
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: 8,
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
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
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
  empty: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.lineStrong,
    borderRadius: 12,
    padding: 16,
    backgroundColor: "rgba(240,236,225,0.4)",
  },
  emptyMark: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.lineStrong },
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
});
