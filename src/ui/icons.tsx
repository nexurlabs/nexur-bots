import type { SVGProps } from 'react'

type IconName =
  | 'arrow-up'
  | 'back'
  | 'bell'
  | 'bell-off'
  | 'brain'
  | 'chevron-right'
  | 'download'
  | 'upload'
  | 'file'
  | 'folder'
  | 'plug'
  | 'sparkle'
  | 'check'
  | 'chevron-down'
  | 'clock'
  | 'close'
  | 'computer'
  | 'copy'
  | 'edit'
  | 'globe'
  | 'image'
  | 'link'
  | 'mic'
  | 'more'
  | 'panel'
  | 'plus'
  | 'search'
  | 'server'
  | 'settings'
  | 'share'
  | 'shield'
  | 'star'
  | 'stop'
  | 'terminal'
  | 'tool'
  | 'trash'
  | 'users'
  | 'bot'
  | 'logout'
  | 'expand'
  | 'minimize'
  | 'refresh'
  | 'reply'
  | 'thread'
  | 'bolt'
  | 'volume'
  | 'react'
  | 'eye'
  | 'eye-off'
  | 'key'
  | 'play'
  | 'memory'

const PATHS: Record<IconName, string> = {
  'chevron-right': 'm9 6 6 6-6 6',
  download: 'M12 3v12M7.5 10.5 12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  upload: 'M12 15V3M7.5 7.5 12 3l4.5 4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  brain: 'M9.5 4a3 3 0 0 0-3 3 3 3 0 0 0-2.5 3 3 3 0 0 0 1 2.3A3 3 0 0 0 7 17.5 3 3 0 0 0 10 20.5V4.6M14.5 4a3 3 0 0 1 3 3 3 3 0 0 1 2.5 3 3 3 0 0 1-1 2.3A3 3 0 0 1 17 17.5 3 3 0 0 1 14 20.5V4.6',
  'bell-off': 'M8.7 3A6 6 0 0 1 18 8c0 2.4.5 4.1 1.1 5.2M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M10.3 21a2 2 0 0 0 3.4 0M2 2l20 20',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  reply: 'M20 20v-7a4 4 0 0 0-4-4H4M9 14 4 9l5-5',
  volume: 'M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  thread: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12ZM8.5 10.5h7M8.5 14h4.5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'eye-off': 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  key: 'M15.5 7.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM10.3 9.7 3 17v4h4v-2h2v-2h2l1.3-1.3',
  react: 'M21 11.5V12a9 9 0 1 1-9-9h.5M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M19 2v6M16 5h6',
  play: 'M7 4.5v15l12-7.5z',
  memory: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  back: 'M19 12H5M12 19l-7-7 7-7',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  check: 'M20 6 9 17l-5-5',
  'chevron-down': 'm6 9 6 6 6-6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  close: 'M18 6 6 18M6 6l12 12',
  computer: 'M4 4h16v11H4zM8 20h8M12 15v5',
  copy: 'M9 9h13v13H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  panel: 'M3 4h18v16H3zM15 4v16',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  server: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  share: 'M12 15V3M7.5 7.5 12 3l4.5 4.5M4 13v5a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  star: 'M12 2.6l2.7 5.9 6.4.7-4.8 4.3 1.4 6.3L12 16.6 6.3 19.8l1.4-6.3L2.9 9.2l6.4-.7z',
  stop: 'M7 7h10v10H7z',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  tool: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  bot: 'M12 8V4H8M4 8h16v12H4zM2 14h2M20 14h2M15 13v2M9 13v2',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'
}

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const filled = name === 'star' || name === 'stop'

  return (
    <svg
      aria-hidden
      fill={filled ? 'currentColor' : 'none'}
      height={size}
      stroke={filled ? 'none' : 'currentColor'}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={size}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

export type { IconName }
