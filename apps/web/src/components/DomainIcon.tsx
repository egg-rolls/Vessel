// biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative icons are marked aria-hidden
import type { Domain } from '../app/router';

/** 领域图标（内联 SVG，无依赖；颜色继承 currentColor）。 */
export function DomainIcon({ domain }: { domain: Domain }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: 'false' as const,
  };
  switch (domain) {
    case 'chat':
      return (
        <svg {...common}>
          <path d="M3.5 4.5h13v9h-7l-4 3v-3h-2z" />
        </svg>
      );
    case 'hub':
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="2.2" />
          <circle cx="10" cy="10" r="5.2" />
          <circle cx="10" cy="10" r="8" />
        </svg>
      );
    case 'gateway':
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="3" />
          <path d="M10 2.5v4.5M10 13v4.5M2.5 10H7M13 10h4.5" />
        </svg>
      );
    case 'nodes':
      return (
        <svg {...common}>
          <rect x="4" y="3.5" width="12" height="5" rx="1" />
          <rect x="4" y="11.5" width="12" height="5" rx="1" />
          <path d="M6.8 6h.01M6.8 14h.01" />
        </svg>
      );
    case 'teams':
      return (
        <svg {...common}>
          <circle cx="7.5" cy="7" r="2.6" />
          <path d="M3.2 16.2c0-2.4 1.9-4.2 4.3-4.2s4.3 1.8 4.3 4.2" />
          <circle cx="14.2" cy="8" r="1.9" />
          <path d="M12.8 12.5c1.9.3 3.3 1.8 3.3 3.7" />
        </svg>
      );
    case 'agents':
      return (
        <svg {...common}>
          <circle cx="10" cy="7" r="2.8" />
          <path d="M4.5 16.2c0-3 2.5-5.4 5.5-5.4s5.5 2.4 5.5 5.4" />
        </svg>
      );
    case 'runs':
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="6.5" />
          <path d="M9 7.4 12.6 10 9 12.6z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'tools':
      return (
        <svg {...common}>
          <path d="M12.2 3.2a3.8 3.8 0 0 0-4.9 4.9L3.6 11.8a1.6 1.6 0 0 0 2.2 2.2l3.7-3.7a3.8 3.8 0 0 0 4.9-4.9l-2 2-1.9-.5-.5-1.9z" />
        </svg>
      );
    case 'mcp':
      return (
        <svg {...common}>
          <circle cx="5" cy="10" r="2.2" />
          <circle cx="15" cy="5.5" r="2.2" />
          <circle cx="15" cy="14.5" r="2.2" />
          <path d="M7.1 9.2 12.9 6.3M7.1 10.8l5.8 2.9" />
        </svg>
      );
    case 'channels':
      return (
        <svg {...common}>
          <path d="M3.5 6.5h4l9 3.5-9 3.5h-4z" />
          <path d="M6.5 13.5v3l3-2" />
        </svg>
      );
    case 'plugins':
      return (
        <svg {...common}>
          <path d="M7.5 3.5h5v2.2a1.8 1.8 0 1 0 0 3.6v2.2h-5z" />
          <path d="M3.5 7.5v5h2.2a1.8 1.8 0 1 1 3.6 0h2.2v-5" />
          <path d="M11.5 16.5v-2.2h2.2a1.8 1.8 0 1 0 0-3.6h-2.2" />
        </svg>
      );
    case 'observe':
      return (
        <svg {...common}>
          <path d="M3 16.5h14" />
          <path d="M5.5 13.5V9" />
          <path d="M10 13.5V5" />
          <path d="M14.5 13.5V7.5" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <path d="M4 6h12" />
          <path d="M4 14h12" />
          <circle cx="8" cy="6" r="1.8" fill="var(--surface)" />
          <circle cx="13" cy="14" r="1.8" fill="var(--surface)" />
        </svg>
      );
  }
}
