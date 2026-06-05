export type JobType = "separation" | "transcript" | "dubbing";

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

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  separation: "Stem separation",
  transcript: "Transcript / Subtitles",
  dubbing: "Dubbing",
};

export interface LanguageOption {
  code: string;
  name: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "en", name: "English" },
  { code: "ko", name: "Korean" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Chinese" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "pt", name: "Portuguese" },
  { code: "it", name: "Italian" },
  { code: "ru", name: "Russian" },
  { code: "hi", name: "Hindi" },
  { code: "vi", name: "Vietnamese" },
];

export interface JobOptions {
  subtitleLanguages: string[];
  dubbingLanguages: string[];
  sourceLanguage: string;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  subtitleLanguages: [],
  dubbingLanguages: [],
  sourceLanguage: "en",
};
