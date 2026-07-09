// vibi brand mark: a white "V" inside a rounded purple square — the same mark as the
// vibi app icon. Kept as inline SVG so it stays crisp at any size and matches the plugin
// icon (icons/icon-23.png is a raster of this same mark, with the icon's gradient flattened
// to a solid fill here because UXP doesn't render SVG gradients).

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
      // UXP tends to ignore <rect rx>, drawing a hard square, so also round the svg box itself via
      // CSS border-radius (well supported) at the same ratio — whichever the runtime honours, the
      // mark reads as a gently rounded chip.
      style={{ borderRadius: `${(size * 9) / 48}px` }}
      aria-hidden="true"
    >
      {/* solid fill, not a gradient: UXP drops SVG gradients (renders the rect black),
          so a flat brand-purple keeps the chip coloured in-panel. */}
      <rect width="48" height="48" rx="9" fill="#5c58c9" />
      <path d="M13.3 12 L18.6 12 L24 28.3 L29.2 12 L34.7 12 L26.8 36 L21 36 Z" fill="#ffffff" />
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
      <span className="brand-wordmark">Vibi</span>
    </div>
  );
}
