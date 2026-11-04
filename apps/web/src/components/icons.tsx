import type { SVGProps } from "react";

/**
 * Inline stroke icon set. Drawn on a 24px grid with a 1.7px stroke so icons sit
 * optically level with 13px text. No icon font, no network request.
 */
const paths: Record<string, string> = {
  dashboard: "M3.5 12.5h6.5V3.5H3.5v9Zm0 8h6.5V15H3.5v5.5Zm10.5 0h6.5v-9H14v9Zm0-17.5v6h6.5v-6H14Z",
  calendar:
    "M8 2.5v4M16 2.5v4M3.5 9.5h17M5.5 4.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z",
  "calendar-plus":
    "M8 2.5v4M16 2.5v4M3.5 9.5h17M5.5 4.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2ZM12 12.5v5M9.5 15h5",
  check: "M20 6.5 9.2 17.3 4 12.1",
  "check-circle": "M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM8.2 12.2l2.6 2.6 5-5.2",
  shield:
    "M12 21.5s7.5-3.7 7.5-9.4V5.4L12 2.6 4.5 5.4v6.7c0 5.7 7.5 9.4 7.5 9.4ZM9 12l2.2 2.2L15.2 10",
  users:
    "M16.5 20.5v-1.7a3.8 3.8 0 0 0-3.8-3.8H6.3a3.8 3.8 0 0 0-3.8 3.8v1.7M9.5 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5ZM21.5 20.5v-1.7a3.8 3.8 0 0 0-2.85-3.68M15.5 4.13a3.75 3.75 0 0 1 0 7.24",
  graduation:
    "M2.5 8.5 12 4l9.5 4.5L12 13 2.5 8.5ZM6.5 10.6v4.6c0 1.8 2.5 3.3 5.5 3.3s5.5-1.5 5.5-3.3v-4.6M21.5 8.5v5",
  building:
    "M3 21h18M5.5 21V6.8L12 3l6.5 3.8V21M9.5 9.5h1M9.5 13h1M9.5 16.5h1M14 9.5h1M14 13h1M14 16.5h1",
  box: "M20.5 8.2a1.9 1.9 0 0 0-.95-1.64l-6.65-3.8a1.9 1.9 0 0 0-1.9 0l-6.65 3.8A1.9 1.9 0 0 0 3.4 8.2v7.6a1.9 1.9 0 0 0 .95 1.64l6.65 3.8a1.9 1.9 0 0 0 1.9 0l6.65-3.8a1.9 1.9 0 0 0 .95-1.64V8.2ZM3.7 7.3 12 12l8.3-4.7M12 21.8V12",
  file: "M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8L14 2.5ZM14 2.5V8h5.5M15.5 13h-7M15.5 17h-7M10 9H8.5",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.3 14.9a1.6 1.6 0 0 0 .32 1.78l.06.06a1.94 1.94 0 1 1-2.74 2.74l-.06-.06a1.6 1.6 0 0 0-1.78-.32 1.6 1.6 0 0 0-.97 1.47V21a1.94 1.94 0 1 1-3.88 0v-.1a1.6 1.6 0 0 0-1.04-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.74-2.74l.06-.06a1.6 1.6 0 0 0 .32-1.78v-.01a1.6 1.6 0 0 0-1.46-.96H3a1.94 1.94 0 1 1 0-3.88h.1a1.6 1.6 0 0 0 1.46-1.04 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.74-2.74l.06.06a1.6 1.6 0 0 0 1.78.32h.01a1.6 1.6 0 0 0 .96-1.46V3a1.94 1.94 0 1 1 3.88 0v.1a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.78-.32l.06-.06a1.94 1.94 0 1 1 2.74 2.74l-.06.06a1.6 1.6 0 0 0-.32 1.78v.01a1.6 1.6 0 0 0 1.46.96H21a1.94 1.94 0 1 1 0 3.88h-.1a1.6 1.6 0 0 0-1.47.97Z",
  user: "M20 21v-1.8a4.2 4.2 0 0 0-4.2-4.2H8.2A4.2 4.2 0 0 0 4 19.2V21M12 11.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2Z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35",
  bell: "M18 8.5a6 6 0 0 0-12 0c0 6.5-2.5 8.5-2.5 8.5h17S18 15 18 8.5M13.73 20.5a2 2 0 0 1-3.46 0",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 1.8v2M12 20.2v2M4.4 4.4l1.4 1.4M18.2 18.2l1.4 1.4M1.8 12h2M20.2 12h2M4.4 19.6l1.4-1.4M18.2 5.8l1.4-1.4",
  moon: "M20.8 13.2A8.8 8.8 0 1 1 10.8 3.2a7 7 0 0 0 10 10Z",
  logout: "M9.5 21H5.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 16.5l4.5-4.5L16 7.5M20.5 12H9.5",
  menu: "M3.5 7h17M3.5 12h17M3.5 17h17",
  x: "M18 6 6 18M6 6l12 12",
  "arrow-right": "M4 12h15M13 6l6 6-6 6",
  "arrow-up-right": "M7 17 17 7M8 7h9v9",
  arrow: "M7 17 17 7M7 7h10v10",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  clock: "M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM12 7v5.2l3.4 2",
  alert:
    "M12 9v4.2M12 17h.01M10.3 3.9 2.2 18a1.9 1.9 0 0 0 1.65 2.9h16.3a1.9 1.9 0 0 0 1.65-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z",
  "alert-circle": "M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM12 7.5v5M12 16.5h.01",
  info: "M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM12 11v5.5M12 7.5h.01",
  qr: "M3.5 3.5h6.5v6.5H3.5zM14 3.5h6.5v6.5H14zM3.5 14H10v6.5H3.5zM14.5 14H17v2.5h-2.5zM20.5 14v2M14.5 19.5v1M18 18h2.5v2.5H18z",
  ticket:
    "M3.5 8.5A1.5 1.5 0 0 1 5 7h14a1.5 1.5 0 0 1 1.5 1.5v1.6a2 2 0 0 0 0 3.8v1.6A1.5 1.5 0 0 1 19 17H5a1.5 1.5 0 0 1-1.5-1.5v-1.6a2 2 0 0 0 0-3.8V8.5ZM15 7v10",
  scan: "M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16M3.5 12h17",
  spark:
    "M12 2.5v3.6M12 17.9v3.6M4.9 4.9l2.6 2.6M16.5 16.5l2.6 2.6M2.5 12h3.6M17.9 12h3.6M4.9 19.1l2.6-2.6M16.5 7.5l2.6-2.6",
  refresh: "M20.5 11.5a8.5 8.5 0 1 1-2.5-6M20.5 3.5v5.5H15",
  chevron: "m9.5 18 6-6-6-6",
  "chevron-down": "m6 9.5 6 6 6-6",
  inbox:
    "M21.5 12h-5.8l-1.9 2.8h-3.6L8.3 12H2.5M5.6 5.3 2.5 12v6a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-6l-3.1-6.7A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.8 1.3Z",
  command:
    "M9 6.5a2.5 2.5 0 1 0-2.5 2.5H9m0-2.5V9m0 0v6m0-6h6M9 15v2.5A2.5 2.5 0 1 1 6.5 15H9Zm0 2.5V15h6m0 0h2.5a2.5 2.5 0 1 0-2.5-2.5V15Zm0 0v2.5A2.5 2.5 0 1 0 17.5 15H15Zm0-6V6.5A2.5 2.5 0 1 1 17.5 9H15Zm0 0h-6",
  pin: "M12 21.5s7-6.2 7-11.5a7 7 0 1 0-14 0c0 5.3 7 11.5 7 11.5ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  mail: "M3.5 6.5h17v11h-17zM3.5 7l8.5 6 8.5-6",
  lock: "M6.5 10.5h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19v-7a1.5 1.5 0 0 1 1.5-1.5ZM8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  "eye-off":
    "M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.7M6.1 8.2A17.4 17.4 0 0 0 2.5 12S6 18 12 18a9.6 9.6 0 0 0 4.2-.95M9.9 9.9a3 3 0 0 0 4.2 4.2",
  download: "M12 3.5v12M7.5 11 12 15.5 16.5 11M4 20.5h16",
  trash:
    "M4 6.5h16M9 6.5V4h6v2.5M6.5 6.5l.8 13a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-13M10 10.5v7M14 10.5v7",
  edit: "M12 20.5h8.5M16.5 3.9a2.1 2.1 0 0 1 3 3L7.5 18.9l-4 1 1-4L16.5 3.9Z",
  filter: "M3.5 5.5h17l-6.5 7.6v5.4l-4 2v-7.4L3.5 5.5Z",
  layers: "M12 2.8 2.8 8 12 13.2 21.2 8 12 2.8ZM2.8 12.2 12 17.4l9.2-5.2M2.8 16.4 12 21.6l9.2-5.2",
  play: "M8 5.5l10 6.5-10 6.5v-13Z",
  stop: "M7 7h10v10H7z",
  grid: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z",
  list: "M8.5 6.5h12M8.5 12h12M8.5 17.5h12M3.5 6.5h.01M3.5 12h.01M3.5 17.5h.01",
  hash: "M9 3.5 7 20.5M17 3.5l-2 17M3.5 9h17M3 15h17",
  coffee:
    "M17.5 9.5h1.5a2.5 2.5 0 0 1 0 5h-1.5M4 9.5h13.5V15a4.5 4.5 0 0 1-4.5 4.5H8.5A4.5 4.5 0 0 1 4 15V9.5ZM7 3v3M11 3v3M15 3v3",
  door: "M4 21h16M6.5 21V3.5h11V21M13.5 12.2h.01",
  book: "M4 4.5A2 2 0 0 1 6 2.5h13.5v17H6a2 2 0 0 0-2 2v-17ZM4 17.5h15.5",
  wallet:
    "M3.5 7.5A2 2 0 0 1 5.5 5.5H19a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 19 19.5H5.5a2 2 0 0 1-2-2v-10ZM3.5 8.5h17M15.5 13h2",
  compass: "M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM15.5 8.5l-2 5-5 2 2-5 5-2Z",
  globe:
    "M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19ZM3 12h18M12 2.5c2.5 2.6 3.8 5.9 3.8 9.5S14.5 18.9 12 21.5C9.5 18.9 8.2 15.6 8.2 12S9.5 5.1 12 2.5Z",
};

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.7,
  ...rest
}: { name: IconName | string; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={paths[name] ?? paths.dashboard} />
    </svg>
  );
}

/**
 * The mark is a ticket stub: an inked square, a perforation and a vermilion
 * seal. It reads at 16px and at 96px without losing its shape.
 */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="logo">
      <span className="logo-mark" aria-hidden="true">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          focusable="false"
          aria-hidden="true"
        >
          <path
            d="M3.5 5.5h17v4.2a2.3 2.3 0 0 0 0 4.6v4.2h-17v-4.2a2.3 2.3 0 0 0 0-4.6V5.5Z"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
          <path
            d="m8 12.1 2.5 2.5 5-5.4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="18.4" cy="12" r="1.35" fill="#b0472b" />
        </svg>
      </span>
      {!compact && (
        <span className="logo-type">
          <span className="logo-word">CampusOps</span>
          <span className="logo-sub">Event operations</span>
        </span>
      )}
    </span>
  );
}
