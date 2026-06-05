export interface SelectionRange {
  startRatio: number;
  endRatio: number;
}

export interface Speaker {
  index: number;
  label: string;
}

export interface TranscriptSegment {
  id: string;
  speakerIndex: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface ScriptDraft {
  speakers: Speaker[];
  segments: TranscriptSegment[];
}
