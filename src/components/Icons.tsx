// Inline SVG copies of the Spectrum workflow icons we use. The Spectrum icon web components
// (<sp-icon-*>) render via shadow DOM and DO NOT paint in the UXP runtime — they showed up blank
// in the panel. Inline SVG does render in UXP (the brand mark uses it), so we embed the same
// 0 0 36 36 / currentColor paths directly. Color follows the surrounding text via currentColor.

import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Spectrum "Import" — file source.
export function IconFile(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M33 2H11a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V6h16v24H14v-3a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h22a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1Z" />
      <path d="M16 25.198a.8.8 0 0 0 .805.802.786.786 0 0 0 .527-.204l7.524-7.445a.5.5 0 0 0 0-.702l-7.524-7.445a.785.785 0 0 0-.527-.204.8.8 0 0 0-.805.802V16H3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h13Z" />
    </Svg>
  );
}

// Spectrum "Folder Open" — project source.
export function IconProject(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M30 14V9a1 1 0 0 0-1-1l-12.332.008-3.3-3.4A2 2 0 0 0 11.929 4H4a2 2 0 0 0-2 2v23a1 1 0 0 0 1 1h26.307a1 1 0 0 0 .936-.649l5.25-14A1 1 0 0 0 34.557 14ZM4 6h7.929l3.305 3.4.59.607h.845L28 10v4H8.693a1 1 0 0 0-.936.649L4 24.667Z" />
    </Svg>
  );
}

// Spectrum "Add To Selection" — timeline selection source.
export function IconTimeline(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m24.16 5.443 1.028-1.777a15.947 15.947 0 0 0-5.4-1.606v2.066a13.883 13.883 0 0 1 4.372 1.317ZM29.53 10.066l1.8-1.035a16.133 16.133 0 0 0-3.852-3.97L26.44 6.849a14.066 14.066 0 0 1 3.09 3.217ZM31.933 16.663H34a15.91 15.91 0 0 0-1.379-5.291L30.83 12.4a13.9 13.9 0 0 1 1.103 4.263ZM31.933 19.337a13.9 13.9 0 0 1-1.1 4.258l1.791 1.032A15.91 15.91 0 0 0 34 19.337ZM26.44 29.151l1.033 1.788a16.131 16.131 0 0 0 3.852-3.97l-1.8-1.035a14.066 14.066 0 0 1-3.085 3.217ZM19.785 31.874v2.066a15.947 15.947 0 0 0 5.4-1.606l-1.025-1.777a13.883 13.883 0 0 1-4.375 1.317ZM12.538 30.894l-1.028 1.777A15.993 15.993 0 0 0 17.107 34v-2.045a13.937 13.937 0 0 1-4.569-1.061ZM6.739 26.293l-1.8 1.035a16.132 16.132 0 0 0 4.214 4.062l1.026-1.775a14.071 14.071 0 0 1-3.44-3.322ZM4.067 19.337H2a15.9 15.9 0 0 0 1.574 5.694L5.365 24a13.889 13.889 0 0 1-1.298-4.663ZM5.365 12l-1.791-1.031A15.9 15.9 0 0 0 2 16.663h2.067A13.889 13.889 0 0 1 5.365 12ZM10.184 6.384 9.158 4.609a16.132 16.132 0 0 0-4.214 4.062l1.8 1.035a14.073 14.073 0 0 1 3.44-3.322ZM17.107 4.045V2a15.99 15.99 0 0 0-5.6 1.329l1.027 1.777a13.937 13.937 0 0 1 4.573-1.061ZM28 19a1 1 0 0 1-1 1h-7v7a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-7H9a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1h7V9a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v7h7a1 1 0 0 1 1 1Z" />
    </Svg>
  );
}

// Spectrum "Audio" — audio media item.
export function IconAudio(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M30 3.417a1 1 0 0 0-1.268-.965l-16 4.447a1 1 0 0 0-.732.964v16.55a6.628 6.628 0 0 0-6.144.057c-3.113 1.515-4.687 4.7-3.515 7.1s4.646 3.136 7.759 1.62a6.434 6.434 0 0 0 3.9-5.333V12.824l14-4v11.589a6.628 6.628 0 0 0-6.144.057c-3.113 1.515-4.687 4.7-3.515 7.1s4.646 3.132 7.759 1.616a6.427 6.427 0 0 0 3.9-5.353V3.417Z" />
    </Svg>
  );
}

// Spectrum "Delete" — trash can, used for the remove/delete affordances. Silhouette only
// (lid + handle + tapered body) so it reads clearly at small sizes without internal cut-outs.
export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 3a2 2 0 0 0-2 2v1H6a1 1 0 0 0 0 2h1.24l1.55 21.14A3 3 0 0 0 11.78 32h12.44a3 3 0 0 0 2.99-2.86L28.76 8H30a1 1 0 0 0 0-2h-7V5a2 2 0 0 0-2-2Zm0 3V5h6v1Zm-5.75 2h17.5l-1.53 20.86a1 1 0 0 1-1 .93H11.78a1 1 0 0 1-1-.93Z" />
      <path d="M15.5 12a1 1 0 0 0-1 1v13a1 1 0 0 0 2 0V13a1 1 0 0 0-1-1ZM20.5 12a1 1 0 0 0-1 1v13a1 1 0 0 0 2 0V13a1 1 0 0 0-1-1Z" />
    </Svg>
  );
}

// Spectrum "Video Outline" — video media item (audio extracted on import).
export function IconVideo(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M31 4H5a1 1 0 0 0-1 1v26a1 1 0 0 0 1 1h26a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1ZM10 29.5a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5Zm0-6.706a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5Zm0-6.588a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5ZM10 9.5a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5ZM24 30H12V20h12Zm0-14H12V6h12Zm6 13.5a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5Zm0-6.706a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5Zm0-6.588a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5ZM30 9.5a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5Z" />
    </Svg>
  );
}
