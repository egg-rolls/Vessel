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
    case 'integrations':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="5.5" height="5.5" rx="1" />
          <rect x="11.5" y="3" width="5.5" height="5.5" rx="1" />
          <rect x="3" y="11.5" width="5.5" height="5.5" rx="1" />
          <rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1" />
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
