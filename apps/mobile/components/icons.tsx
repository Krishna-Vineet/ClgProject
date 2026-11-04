import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "./ui";

const paths: Record<string, string> = {
  events:
    "M6.5 3.5v3M17.5 3.5v3M3.5 9.5h17M5.5 5.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z",
  passes:
    "M3.5 8.5A1.5 1.5 0 0 1 5 7h14a1.5 1.5 0 0 1 1.5 1.5v1.6a2 2 0 0 0 0 3.8v1.6A1.5 1.5 0 0 1 19 17H5a1.5 1.5 0 0 1-1.5-1.5v-1.6a2 2 0 0 0 0-3.8V8.5ZM15 7v10",
  scan: "M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16M3.5 12h17",
  inbox:
    "M21 12h-5.5l-1.8 2.6h-3.4L8.5 12H3M5.6 5.4 3 12v5.5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V12l-2.6-6.6A2 2 0 0 0 16.5 4h-9a2 2 0 0 0-1.9 1.4Z",
  user: "M20 21v-1.8a4.2 4.2 0 0 0-4.2-4.2H8.2A4.2 4.2 0 0 0 4 19.2V21M12 11.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2Z",
  help: "M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.4M12 17h.01",
  alert:
    "M12 9v4.2M12 17h.01M10.3 3.9 2.2 18a1.9 1.9 0 0 0 1.65 2.9h16.3a1.9 1.9 0 0 0 1.65-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z",
  check: "M20 6.5 9.2 17.3 4 12.1",
  chevron: "m9.5 18 6-6-6-6",
  pin: "M12 21.5s7-6.2 7-11.5a7 7 0 1 0-14 0c0 5.3 7 11.5 7 11.5ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
};

export type AppIconName = keyof typeof paths;

export function AppIcon({
  name,
  size = 22,
  color = colors.muted,
  strokeWidth = 1.7,
}: {
  name: AppIconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d={(paths[name] ?? paths.events) as string}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The ticket-stub mark, shared with the console. */
export function Logo({ size = 30, inverse = false }: { size?: number; inverse?: boolean }) {
  const bg = inverse ? colors.cream : colors.dark;
  const fg = inverse ? colors.dark : colors.cream;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Rect x="0" y="0" width="32" height="32" rx="8" fill={bg} />
      <Path
        d="M8 10h16v3.6a2.4 2.4 0 0 0 0 4.8V22H8v-3.6a2.4 2.4 0 0 0 0-4.8V10Z"
        stroke={fg}
        strokeWidth="1.9"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="m12 16 2.6 2.6L20 13"
        stroke={fg}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx="23.2" cy="16" r="1.5" fill={colors.primary} />
    </Svg>
  );
}
