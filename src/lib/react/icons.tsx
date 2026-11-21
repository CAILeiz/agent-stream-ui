import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function SendIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 11.5 20 4l-7.5 16-1.8-6.2L4 11.5Z" />
    </svg>
  )
}

export function StopIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function RetryIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4h-4" />
    </svg>
  )
}

export function ToolIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M14.7 6.3a4 4 0 0 0 5 5l-8.4 8.4a2.4 2.4 0 0 1-3.4-3.4l8.4-8.4a4 4 0 0 0-1.6-1.6Z" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 8v5" />
      <path d="M12 16.5v.5" />
      <path d="M10.3 4.3 2.9 17.4A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.6L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    </svg>
  )
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </svg>
  )
}

export function SparkIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </svg>
  )
}
