import { StemCard } from "./StemCard";
import { isAutoSpeakerLabel, isBackgroundStemId, stemGroupLabel } from "../types/job";

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
  // Unique per card (entry.id); StemCard namespaces the global playback id with it.
  cardKey: string;
  activeId: string | null;
  onRequestActive: (id: string, active: boolean) => void;
  onVolumeChange: (id: string, volume: number) => void;
  onToggleSelected: (id: string, selected: boolean) => void;
}

// The label column is sized to fit the *longest* name across BOTH groups so speaker and background
// labels line up at the same width, capped so a very long custom name ellipsizes instead of pushing
// the waveform off-screen. UXP can't measure text, so estimate from character widths at 11px/500:
// wide (CJK) glyphs ~12px, everything else ~6.5px (the same heuristic ScriptEditor uses for tags).
const MAX_LABEL_WIDTH = 78;
function labelWidthFor(labels: string[]): number {
  const widthOf = (label: string) =>
    [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0xff ? 12 : 6.5), 0);
  const widest = labels.reduce((max, label) => Math.max(max, widthOf(label)), 0);
  return Math.min(MAX_LABEL_WIDTH, Math.ceil(widest) + 2); // +2 so the exact-fit longest doesn't clip
}

export function StemListView({
  stems,
  cardKey,
  activeId,
  onRequestActive,
  onVolumeChange,
  onToggleSelected,
}: Props) {
  // Split into the two natural groups — voices and background — each under its own header so the
  // per-stem names can stay short (the header carries the category). Order within a group is
  // preserved; empty groups render nothing.
  const speakers = stems.filter((s) => !isBackgroundStemId(s.id));
  const backgrounds = stems.filter((s) => isBackgroundStemId(s.id));

  // A genuinely renamed speaker (e.g. from the script editor's "Regenerate audio") wins over the
  // numeric group label — otherwise the rename shows only in the tooltip and the card keeps the bare
  // index. Background stems and un-renamed speakers still collapse to the short group label.
  const displayLabelOf = (stem: StemView) =>
    !isBackgroundStemId(stem.id) && !isAutoSpeakerLabel(stem.label)
      ? stem.label
      : stemGroupLabel(stem.id) ?? stem.label;
  // One shared width for every card, both groups, so all names align.
  const labelWidth = labelWidthFor(stems.map(displayLabelOf));

  const renderCard = (stem: StemView) => (
    <StemCard
      key={stem.id}
      stem={stem}
      // Short in-group label ("1", "No reaction"); full name ("Speaker 1") stays in the tooltip.
      displayLabel={displayLabelOf(stem)}
      labelWidth={labelWidth}
      cardKey={cardKey}
      audioUrl={stem.audioUrl}
      isActive={activeId === stem.id}
      onRequestActive={(active) => onRequestActive(stem.id, active)}
      onVolumeChange={(v) => onVolumeChange(stem.id, v)}
      onToggleSelected={(s) => onToggleSelected(stem.id, s)}
    />
  );

  return (
    <div className="stem-groups">
      {speakers.length > 0 && (
        <div className="stem-group">
          <GroupTitle label="Speakers" count={speakers.length} />
          <ul className="stem-cards">{speakers.map(renderCard)}</ul>
        </div>
      )}
      {backgrounds.length > 0 && (
        <div className="stem-group">
          <GroupTitle label="Background" count={backgrounds.length} />
          <ul className="stem-cards">{backgrounds.map(renderCard)}</ul>
        </div>
      )}
    </div>
  );
}

// Group header: name — hairline rule — count, so each group reads as its own labelled section.
function GroupTitle({ label, count }: { label: string; count: number }) {
  return (
    <div className="stem-group-title">
      <span>{label}</span>
      <span className="stem-group-rule" />
      <span className="stem-group-count">{count}</span>
    </div>
  );
}
