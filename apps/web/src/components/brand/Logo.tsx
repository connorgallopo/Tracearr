import { cn } from '@/lib/utils';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showText?: boolean;
  className?: string;
}

const sizes = {
  sm: { icon: 'h-6 w-6', text: 'text-lg' },
  md: { icon: 'h-8 w-8', text: 'text-xl' },
  lg: { icon: 'h-12 w-12', text: 'text-3xl' },
  xl: { icon: 'h-16 w-16', text: 'text-4xl' },
};

export function Logo({ size = 'md', showText = true, className }: LogoProps) {
  const { icon, text } = sizes[size];

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <LogoIcon className={icon} />
      {showText && <span className={cn('font-bold tracking-tight', text)}>Tracearr</span>}
    </div>
  );
}

interface LogoIconProps {
  className?: string;
}

export function LogoIcon({ className }: LogoIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      className={cn('shrink-0', className)}
    >
      {/* Background shield shape */}
      <path
        d="M32 4L8 14v18c0 14 10 24 24 28 14-4 24-14 24-28V14L32 4z"
        className="fill-blue-core"
      />
      {/* Inner shield */}
      <path
        d="M32 8L12 16v14c0 12 8.5 20.5 20 24 11.5-3.5 20-12 20-24V16L32 8z"
        className="fill-blue-steel"
      />
      {/* T-path stylized */}
      <path d="M22 24h20v4H34v16h-4V28H22v-4z" className="fill-cyan-core" />
      {/* Radar arcs */}
      <path
        d="M32 20a16 16 0 0 1 11.3 4.7"
        className="stroke-cyan-core"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        opacity="0.6"
      />
      <path
        d="M32 16a20 20 0 0 1 14.1 5.9"
        className="stroke-cyan-core"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        opacity="0.4"
      />
      <path
        d="M32 12a24 24 0 0 1 17 7"
        className="stroke-cyan-core"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        opacity="0.2"
      />
    </svg>
  );
}
