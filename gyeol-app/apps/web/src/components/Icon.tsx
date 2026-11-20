import type { TimeMode } from '@gyeol/core';

/** 선 아이콘 (24 격자, 선 굵기 1.8). 색은 currentColor */
const PATHS = {
  back: <path d="M15 6l-6 6 6 6" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  bullet: (
    <g transform="rotate(45 12 12)">
      <path d="M8.6 21.5V11.5c0-3.8 1.4-6.9 3.4-9 2 2.1 3.4 5.2 3.4 9v10z" />
      <path d="M8.6 17h6.8" />
    </g>
  ),
  blitz: <path d="M13.5 2.5L5 13.5h6.2L10 21.5l9-11.5h-6.4z" />,
  rapid: (
    <>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 13.5V9.5M9.5 2.5h5M12 2.5V6M18.2 7.3l1.6-1.6" />
    </>
  ),
  daily: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
    </>
  ),
  invite: (
    <>
      <circle cx="9.5" cy="8.5" r="3.5" />
      <path d="M3 20c.7-3.4 3.2-5.5 6.5-5.5s5.8 2.1 6.5 5.5M18.5 8v6M15.5 11h6" />
    </>
  ),
  code: <path d="M9.5 3.5L7.5 20.5M16.5 3.5l-2 17M4 9h16.5M3.5 15H20" />,
  ai: (
    <>
      <rect x="5" y="7" width="14" height="11" rx="2.5" />
      <path d="M12 7V4M9.5 12h.01M14.5 12h.01M9.5 15h5" />
    </>
  ),
  puzzle: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2.5" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  stairs: <path d="M3.5 20.5h5v-5h4v-5h4v-5h4M3.5 20.5V17" />,
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="10" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  local: <path d="M7 7h11l-3-3M17 17H6l3 3" />,
  learn: <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5v-14zM5 19.5A1.5 1.5 0 0 0 6.5 21H19" />,
  me: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />
    </>
  ),
  lobby: <path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5V11z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  first: <path d="M7 5v14M18 6l-7 6 7 6" />,
  prev: <path d="M15 6l-6 6 6 6" />,
  next: <path d="M9 6l6 6-6 6" />,
  last: <path d="M17 5v14M6 6l7 6-7 6" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`ico ${className}`} aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

export const modeIcon = (m: TimeMode): IconName => m;
