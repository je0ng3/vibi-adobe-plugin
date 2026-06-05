import { useEffect, useState } from "react";
import { SpeakerMap } from "./SpeakerMap";
import { TranscriptEditor } from "./TranscriptEditor";
import { JOB_TYPE_LABELS, type JobType, type ScriptDraft, type TranscriptSegment } from "../types/job";

interface Props {
  fileName: string;
  initialDraft: ScriptDraft;
  jobs: Set<JobType>;
  onCancel: () => void;
  onSave: (finalDraft: ScriptDraft) => void;
}

export function ScriptEditorModal({ fileName, initialDraft, jobs, onCancel, onSave }: Props) {
  const [draft, setDraft] = useState<ScriptDraft>(initialDraft);

  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  function updateSpeakerLabel(index: number, label: string) {
    setDraft((d) => ({
      ...d,
      speakers: d.speakers.map((sp) => (sp.index === index ? { ...sp, label } : sp)),
    }));
  }

  function addSpeaker() {
    setDraft((d) => {
      const nextIndex = d.speakers.reduce((m, sp) => Math.max(m, sp.index), 0) + 1;
      return {
        ...d,
        speakers: [...d.speakers, { index: nextIndex, label: `Speaker ${nextIndex}` }],
      };
    });
  }

  function removeSpeaker(index: number) {
    setDraft((d) => {
      if (d.speakers.length <= 1) return d;
      const remaining = d.speakers.filter((sp) => sp.index !== index);
      const fallback = remaining[0].index;
      return {
        ...d,
        speakers: remaining,
        segments: d.segments.map((seg) =>
          seg.speakerIndex === index ? { ...seg, speakerIndex: fallback } : seg,
        ),
      };
    });
  }

  function updateSegment(id: string, partial: Partial<TranscriptSegment>) {
    setDraft((d) => ({
      ...d,
      segments: d.segments.map((seg) => (seg.id === id ? { ...seg, ...partial } : seg)),
    }));
  }

  const jobList = jobs.size > 0
    ? Array.from(jobs).map((j) => JOB_TYPE_LABELS[j]).join(" · ")
    : "No jobs selected yet";

  return (
    <div className="script-modal-backdrop" role="dialog" aria-modal="true">
      <div className="script-modal">
        <header className="script-modal-header">
          <div className="script-modal-titles">
            <h3 className="script-modal-title">Review transcript</h3>
            <p className="script-modal-sub">{fileName} · {jobList}</p>
          </div>
          <button className="script-modal-close" type="button" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </header>

        <div className="script-modal-body">
          <SpeakerMap
            speakers={draft.speakers}
            onChangeLabel={updateSpeakerLabel}
            onAdd={addSpeaker}
            onRemove={removeSpeaker}
          />
          <TranscriptEditor
            speakers={draft.speakers}
            segments={draft.segments}
            onSegmentChange={updateSegment}
          />
        </div>

        <footer className="script-modal-footer">
          <sp-button variant="secondary" treatment="outline" size="s" onClick={onCancel}>
            Cancel
          </sp-button>
          <sp-button variant="accent" onClick={() => onSave(draft)}>
            Save
          </sp-button>
        </footer>
      </div>
    </div>
  );
}
