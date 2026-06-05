import { StemCard } from "./StemCard";

export interface StemView {
  id: string;
  label: string;
  volume: number;
  selected: boolean;
  peaks: Float32Array | null;
  audioUrl: string | null;
  durationSec: number;
}

interface Props {
  stems: StemView[];
  activeId: string | null;
  onRequestActive: (id: string, active: boolean) => void;
  onVolumeChange: (id: string, volume: number) => void;
  onToggleSelected: (id: string, selected: boolean) => void;
}

export function StemListView({
  stems,
  activeId,
  onRequestActive,
  onVolumeChange,
  onToggleSelected,
}: Props) {
  return (
    <ul className="stem-cards">
      {stems.map((stem) => (
        <StemCard
          key={stem.id}
          stem={stem}
          audioUrl={stem.audioUrl}
          isActive={activeId === stem.id}
          onRequestActive={(active) => onRequestActive(stem.id, active)}
          onVolumeChange={(v) => onVolumeChange(stem.id, v)}
          onToggleSelected={(s) => onToggleSelected(stem.id, s)}
        />
      ))}
    </ul>
  );
}
