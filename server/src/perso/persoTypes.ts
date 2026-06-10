export class PersoApiError extends Error {
  constructor(public status: number, message: string) {
    super(`Perso ${status}: ${message}`);
    this.name = "PersoApiError";
  }
}

export interface PersoSasTokenResponse {
  blobSasUrl: string;
  expirationDatetime?: string;
}

export interface PersoMediaRegistration {
  seq: number;
  durationMs?: number | null;
}

export interface PersoProgress {
  projectSeq?: number;
  progress: number;
  progressReason?: string | null;
  hasFailed?: boolean;
}

export interface PersoScriptSentence {
  seq: number;
  speakerOrderIndex: number;
  offsetMs: number;
  durationMs: number;
  originalText: string;
  audioUrl?: string | null;
}

export interface PersoScriptSpeaker {
  speakerOrderIndex: number;
  externalSpeakerSeq?: string | null;
}

export interface PersoScriptPage {
  hasNext: boolean;
  nextCursorId?: number | null;
  sentences: PersoScriptSentence[];
  speakers: PersoScriptSpeaker[];
}

export interface PersoDownloadInfo {
  hasOriginalSpeakerAudioCollection?: boolean;
  hasOriginalBackground?: boolean;
  hasTranslateAudio?: boolean | null;
  hasTranslatedVoice?: boolean | null;
}

export interface PersoDownloadPathInfo {
  originalBackgroundPath?: string | null;
}

export interface PersoProjectInfo {
  seq?: number | null;
  downloadInfo?: PersoDownloadInfo | null;
  downloadPathInfo?: PersoDownloadPathInfo | null;
}

export interface PersoSeparationDownloadLinks {
  audioFile?: {
    voiceAudioDownloadLink?: string | null;
    originalSubBackgroundDownloadLink?: string | null;
  } | null;
}
