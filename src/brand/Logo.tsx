// vibi brand mark: a waveform inside a rounded gradient square — a tiny echo of the
// waveform shown in-app. Kept as inline SVG so it stays crisp at any size and matches
// the plugin icon (icons/icon-23.png is a raster of this same mark).

interface MarkProps {
  size?: number;
  className?: string;
}

export function BrandMark({ size = 24, className }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="vibiGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2680eb" />
          <stop offset="1" stopColor="#7b5bff" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="11" fill="url(#vibiGrad)" />
      <g fill="#ffffff">
        <rect x="9.9" y="17" width="3.4" height="14" rx="1.7" opacity="0.92" />
        <rect x="16.1" y="11" width="3.4" height="26" rx="1.7" />
        <rect x="22.3" y="20" width="3.4" height="8" rx="1.7" opacity="0.88" />
        <rect x="28.5" y="14" width="3.4" height="20" rx="1.7" opacity="0.96" />
        <rect x="34.7" y="19" width="3.4" height="10" rx="1.7" opacity="0.84" />
      </g>
    </svg>
  );
}

interface LockupProps {
  size?: number;
}

// Mark + wordmark, used in the panel header and the sign-in screen.
export function BrandLockup({ size = 24 }: LockupProps) {
  return (
    <div className="brand-lockup">
      <BrandMark size={size} />
      <span className="brand-wordmark">vibi</span>
    </div>
  );
}
