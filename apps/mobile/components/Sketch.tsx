import Svg, { Circle, G, Path } from "react-native-svg";
import { colors } from "./ui";

/**
 * Monochrome doodles for the student app.
 *
 * One ink colour, one stroke weight, drawn the way a margin note is drawn: no
 * fills, no gradients, nothing that needs a second colour to make sense. That is
 * what lets the same artwork sit on the paper cards, on the dark pass card, and
 * at 12% opacity behind a screen without being redrawn for each surface.
 *
 * All of these are pure `react-native-svg`, so they render identically on iOS,
 * Android and the browser preview — no PNG assets, no bundler traps, and they
 * stay sharp when a screen is scaled up.
 */
export type Doodle =
  | "campus"
  | "calendar"
  | "pass"
  | "ticket"
  | "arrow"
  | "sparkle"
  | "confetti"
  | "route"
  | "book"
  | "key"
  | "megaphone"
  | "clock"
  | "coffee"
  | "wave"
  | "stamp";

type Props = {
  name: Doodle;
  size?: number;
  color?: string;
  /** Multiplies the colour's opacity without needing an rgba() per screen. */
  faint?: boolean;
  strokeWidth?: number;
};

const D: Record<Doodle, Array<{ d: string; width?: number; opacity?: number }>> = {
  campus: [
    { d: "M14 96h172" },
    { d: "M26 96V62l22-16 22 16v34" },
    { d: "M34 96V72h26v24" },
    { d: "M80 96V46h34v50" },
    { d: "M86 56h22M86 66h22M86 76h22" },
    { d: "M126 96V36l26 12v48" },
    { d: "M162 96V58h28v38" },
    { d: "M18 102c28 8 74 9 118 3s46-6 58-2", width: 1.6, opacity: 0.5 },
  ],
  calendar: [
    { d: "M30 30h140a6 6 0 016 6v128a6 6 0 01-6 6H30a6 6 0 01-6-6V36a6 6 0 016-6z" },
    { d: "M24 58h152" },
    { d: "M58 18v22M142 18v22" },
    { d: "M48 78h18v16H48zM84 78h18v16H84zM120 78h18v16h-18z" },
    { d: "M48 108h18v16H48zM84 108h18v16H84z" },
    { d: "M32 150c30-6 64-8 100-4", width: 1.6, opacity: 0.5 },
  ],
  pass: [
    {
      d: "M34 60h124a10 10 0 0110 10v20a14 14 0 000 26v20a10 10 0 01-10 10H34a10 10 0 01-10-10V116a14 14 0 000-26V70a10 10 0 0110-10z",
    },
    { d: "M112 60v96" },
    { d: "M46 84h46M46 102h36M46 120h42" },
    { d: "M126 86h16M126 104h10" },
    { d: "M24 168c40 6 84 4 122-4", width: 1.6, opacity: 0.45 },
  ],
  ticket: [
    { d: "M38 56h116v34a12 12 0 000 24v30H38v-30a12 12 0 000-24z" },
    { d: "M96 56v88", width: 1.6, opacity: 0.5 },
    { d: "M52 80h30M52 100h22M52 120h28" },
  ],
  arrow: [{ d: "M22 84C58 60 100 46 158 44" }, { d: "M138 34l22 10-12 20" }],
  sparkle: [
    { d: "M96 30v40M96 130v40M40 100h34M126 100h34" },
    { d: "M62 66l20 20M130 134l-20-20M128 70l-20 20M66 134l20-20" },
    { d: "M96 84a16 16 0 1016 16 16 16 0 00-16-16z" },
  ],
  confetti: [
    { d: "M32 44l14 18M72 26l6 22M120 32l-8 20M160 56l-16 14" },
    { d: "M44 122l18 10M92 150l10-16M146 130l-12 14" },
    { d: "M60 76a14 14 0 1020 14" },
    { d: "M112 92l22-12M120 118l18 14" },
  ],
  route: [
    { d: "M28 148c26-52 62-12 86-46s40-42 58-30" },
    { d: "M156 56l18 14-20 12" },
    { d: "M28 148a8 8 0 1016 0 8 8 0 00-16 0z" },
  ],
  book: [
    { d: "M46 34h108v132H46z" },
    { d: "M46 34h30v132" },
    { d: "M86 62h52M86 84h52M86 106h38" },
    { d: "M30 174c40 4 90 2 132-6", width: 1.6, opacity: 0.45 },
  ],
  key: [
    { d: "M64 78a28 28 0 1028 28 28 28 0 00-28-28z" },
    { d: "M86 100l62-38" },
    { d: "M132 54l16 12-10 14" },
    { d: "M28 152c32 8 76 10 112 2", width: 1.6, opacity: 0.45 },
  ],
  megaphone: [
    { d: "M38 84l66-32v92l-66-30z" },
    { d: "M38 84a13 13 0 000 26h10l4 30h18l-4-30" },
    { d: "M114 52h10a44 44 0 010 92h-10" },
    { d: "M22 156c36 10 88 12 136 4", width: 1.6, opacity: 0.45 },
  ],
  clock: [
    { d: "M96 40a56 56 0 1056 56 56 56 0 00-56-56z" },
    { d: "M96 62v36l26 16" },
    { d: "M96 22v12M96 162v12M22 96h12M158 96h12" },
  ],
  coffee: [
    { d: "M46 84h80v40a32 32 0 01-32 32H78a32 32 0 01-32-32z" },
    { d: "M126 96h18a16 16 0 010 32h-18" },
    { d: "M64 62c-6-10 6-14 0-24M92 62c-6-10 6-14 0-24" },
    { d: "M34 176c40 4 96 2 140-6", width: 1.6, opacity: 0.45 },
  ],
  wave: [
    { d: "M18 108c18-22 36-22 54 0s36 22 54 0 36-22 54 0" },
    { d: "M18 140c18-22 36-22 54 0s36 22 54 0 36-22 54 0", opacity: 0.5, width: 1.6 },
  ],
  stamp: [
    { d: "M56 62h80v40H56z" },
    { d: "M48 102h96v46H48z" },
    { d: "M76 62c0-16 40-16 40 0" },
    { d: "M66 122h60M72 134h48", width: 1.6, opacity: 0.5 },
  ],
};

export function Sketch({
  name,
  size = 120,
  color = colors.ink,
  faint = false,
  strokeWidth = 2,
}: Props) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 192 192"
      fill="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={faint ? { opacity: 0.14 } : undefined}
    >
      <G
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={1}
      >
        {D[name].map((part, i) => (
          <Path
            // biome-ignore lint/suspicious/noArrayIndexKey: the paths of a doodle are positional
            key={`${name}-${i}`}
            d={part.d}
            strokeWidth={part.width ?? strokeWidth}
            opacity={part.opacity ?? 1}
          />
        ))}
      </G>
    </Svg>
  );
}

/** A ring-and-dot marker, used to annotate rather than illustrate. */
export function Dot({ size = 8, color = colors.primary }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12">
      <Circle cx="6" cy="6" r="3" fill={color} />
    </Svg>
  );
}
