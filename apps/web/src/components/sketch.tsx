import { type CSSProperties, useEffect, useRef, useState } from "react";

/**
 * Big, hand-drawn line art for the empty spaces in the console.
 *
 * Everything here is inline SVG with `currentColor` and no raster assets: it
 * inherits the theme, stays sharp at any size, costs a few kB instead of a
 * download, and can be animated by the same CSS that draws it. The stroke style
 * imitates a pen (slightly uneven paths, round caps, a hand-lettered feel)
 * because a management console that looks like a printed notebook is easier to
 * scan than another wall of grey cards.
 *
 * All motion is decorative and respects `prefers-reduced-motion` (see the CSS).
 */
export type SketchName =
  | "campus"
  | "calendar"
  | "checklist"
  | "key"
  | "ticket"
  | "room"
  | "megaphone"
  | "clipboard"
  | "chart"
  | "search"
  | "inbox"
  | "spark";

const PATHS: Record<SketchName, string[]> = {
  // A campus skyline — the console's own subject.
  campus: [
    "M10 96h180",
    "M22 96V60l20-14 20 14v36",
    "M30 96V70h24v26",
    "M74 96V44h34v52",
    "M80 54h22M80 64h22M80 74h22",
    "M120 96V34l26 12v50",
    "M126 44l14 6v10l-14-6z",
    "M158 96V56h30v40",
    "M164 64h18M164 74h18M164 84h18",
    "M16 100c26 6 62 8 96 4s56-6 72-2",
  ],
  calendar: [
    "M28 30h144a6 6 0 016 6v128a6 6 0 01-6 6H28a6 6 0 01-6-6V36a6 6 0 016-6z",
    "M22 58h156",
    "M56 18v22M144 18v22",
    "M46 78h20v18H46zM86 78h20v18H86zM126 78h20v18h-20z",
    "M46 110h20v18H46zM86 110h20v18H86z",
    "M28 152c30-8 62-10 100-6",
  ],
  checklist: [
    "M34 26h124v144H34z",
    "M60 18h24l4 12H56z",
    "M50 60l8 8 14-16",
    "M84 62h58",
    "M50 96l8 8 14-16",
    "M84 98h58",
    "M50 132l8 8 14-16",
    "M84 134h40",
    "M158 168c-18 8-52 10-86 4",
  ],
  key: [
    "M64 76a30 30 0 1030 30 30 30 0 00-30-30z",
    "M88 96l64-40",
    "M136 52l14 12-12 14",
    "M122 62l12 10",
    "M28 150c34 10 78 12 116 4",
    "M40 40l-8-8M150 140l10 8",
  ],
  ticket: [
    "M32 58h120a10 10 0 0110 10v22a14 14 0 000 28v22a10 10 0 01-10 10H32a10 10 0 01-10-10v-22a14 14 0 000-28V68a10 10 0 0110-10z",
    "M112 58v96",
    "M44 82h48M44 100h38M44 118h44",
    "M124 82h18M124 100h12",
    "M24 168c40 8 84 6 122-4",
  ],
  room: [
    "M34 44h132v104H34z",
    "M34 44l66-24 66 24",
    "M100 20v128",
    "M52 70h34v30H52zM116 70h34v30h-34z",
    "M52 116h34v20H52z",
    "M116 112h34",
    "M150 120a8 8 0 018 8 8 8 0 01-8 8",
    "M18 160c50 10 108 10 164 0",
  ],
  megaphone: [
    "M36 82l70-34v96L36 110z",
    "M36 82a14 14 0 000 28h12l4 32h20l-6-32",
    "M118 48h12a48 48 0 010 96h-12",
    "M120 66a30 30 0 010 60",
    "M20 150c38 12 90 14 140 4",
    "M152 34l10-10M158 56h14",
  ],
  clipboard: [
    "M46 32h108v140H46z",
    "M76 22h48v18H76z",
    "M64 70h72M64 92h72M64 114h50",
    "M64 140h20M92 140h20M120 140h16",
    "M30 172c44 8 94 8 140-2",
  ],
  chart: [
    "M30 24v140h150",
    "M54 140V96M88 140V70M122 140V104M156 140V54",
    "M54 88l34-26 34 22 34-44",
    "M156 40l10-2-2 12",
    "M18 168c52 8 112 8 168-4",
  ],
  search: [
    "M92 40a48 48 0 1048 48 48 48 0 00-48-48z",
    "M130 122l40 40",
    "M70 74c8-10 20-14 32-12",
    "M18 168c52 10 112 10 168-2",
  ],
  inbox: [
    "M32 66h136v92H32z",
    "M32 66l68 52 68-52",
    "M18 52l82-30 82 30",
    "M48 152h104",
    "M64 100h30M64 116h18",
  ],
  spark: [
    "M100 24v52M100 132v52M40 100h52M132 100h52",
    "M60 60l32 32M132 132l-32-32M140 60l-32 32M68 132l32-32",
    "M100 84a16 16 0 1016 16 16 16 0 00-16-16z",
  ],
};

export function Sketch({
  name,
  className,
  width = "100%",
  height,
  title,
}: {
  name: SketchName;
  className?: string;
  width?: number | string;
  height?: number | string;
  title?: string;
}) {
  const paths = PATHS[name];
  return (
    <svg
      viewBox="0 0 200 200"
      className={`sketch sketch-${name}${className ? ` ${className}` : ""}`}
      style={{ width, ...(height === undefined ? {} : { height }) }}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paths are positional art
        <path key={i} d={d} className="sketch-line" style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </svg>
  );
}

/**
 * A wide background composition: several sketches at different scales, drifting
 * slowly and at different speeds so the surface never looks static but also
 * never pulls the eye away from the work. Purely decorative.
 */
export function SketchBackdrop() {
  return (
    <div className="sketch-backdrop" aria-hidden="true">
      <Sketch name="campus" className="drift-a" width={420} />
      <Sketch name="calendar" className="drift-b" width={260} />
      <Sketch name="key" className="drift-c" width={200} />
      <Sketch name="spark" className="drift-d" width={150} />
      <Sketch name="room" className="drift-e" width={300} />
    </div>
  );
}

/**
 * A drawn underline that sweeps in behind a heading. Used on the page title so
 * each section opens with the same small piece of motion.
 */
export function SketchUnderline({ className }: { className?: string }) {
  return (
    <svg
      className={`sketch-underline${className ? ` ${className}` : ""}`}
      viewBox="0 0 240 12"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <path
        d="M3 8c42-6 92-7 140-4s72 3 94-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Draws a connection between two points: used on the dashboard to link a task
 * to the page that finishes it. The path length is measured at runtime so the
 * animation works for any curve.
 */
export function Connector({ className, ...rest }: { className?: string } & CSSProperties) {
  const ref = useRef<SVGPathElement>(null);
  const [len, setLen] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    try {
      setLen(ref.current.getTotalLength());
    } catch {
      setLen(0);
    }
  }, []);
  return (
    <svg
      className={`connector${className ? ` ${className}` : ""}`}
      viewBox="0 0 300 80"
      aria-hidden="true"
      style={rest as CSSProperties}
    >
      <path
        ref={ref}
        d="M6 62C58 58 74 14 128 16s86 44 166 38"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray={len || undefined}
        strokeDashoffset={len || undefined}
        className="connector-line"
      />
    </svg>
  );
}
