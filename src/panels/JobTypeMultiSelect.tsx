import {
  JOB_TYPE_LABELS,
  LANGUAGE_OPTIONS,
  type JobOptions,
  type JobType,
} from "../types/job";

interface Props {
  selected: Set<JobType>;
  options: JobOptions;
  hideSeparation?: boolean;
  onToggle: (job: JobType, on: boolean) => void;
  onOptionsChange: (next: JobOptions) => void;
  busy?: boolean;
}

const ALL_JOBS: JobType[] = ["separation", "transcript", "dubbing"];

export function JobTypeMultiSelect({
  selected,
  options,
  hideSeparation,
  onToggle,
  onOptionsChange,
  busy,
}: Props) {
  const JOBS = hideSeparation ? ALL_JOBS.filter((j) => j !== "separation") : ALL_JOBS;

  function toggleSubtitleLang(code: string, on: boolean) {
    const set = new Set(options.subtitleLanguages);
    if (on) set.add(code);
    else set.delete(code);
    onOptionsChange({ ...options, subtitleLanguages: Array.from(set) });
  }

  function toggleDubbingLang(code: string, on: boolean) {
    const set = new Set(options.dubbingLanguages);
    if (on) set.add(code);
    else set.delete(code);
    onOptionsChange({ ...options, dubbingLanguages: Array.from(set) });
  }

  return (
    <div className="job-multi-select">
      <div className="job-multi-select-list">
        {JOBS.map((job) => (
          <div key={job} className="job-multi-row">
            <label className="job-multi-option">
              <input
                type="checkbox"
                checked={selected.has(job)}
                onChange={(e) => onToggle(job, e.currentTarget.checked)}
                disabled={busy || undefined}
              />
              <span>{JOB_TYPE_LABELS[job]}</span>
            </label>

            {job === "transcript" && selected.has(job) && (
              <div className="job-lang-row">
                <span className="job-lang-label">Languages</span>
                <div className="job-lang-chips">
                  {LANGUAGE_OPTIONS.map((lang) => {
                    const on = options.subtitleLanguages.includes(lang.code);
                    return (
                      <button
                        key={lang.code}
                        type="button"
                        className={`job-lang-chip${on ? " job-lang-chip--on" : ""}`}
                        onClick={() => toggleSubtitleLang(lang.code, !on)}
                        disabled={busy || undefined}
                      >
                        {lang.name}
                      </button>
                    );
                  })}
                </div>
                <p className="job-lang-hint">
                  {options.subtitleLanguages.length === 0
                    ? "Original only (no translation)"
                    : `${options.subtitleLanguages.length} translation${options.subtitleLanguages.length === 1 ? "" : "s"} + original`}
                </p>
              </div>
            )}

            {job === "dubbing" && selected.has(job) && (
              <div className="job-lang-row">
                <span className="job-lang-label">Source language</span>
                <select
                  className="job-lang-select"
                  value={options.sourceLanguage}
                  onChange={(e) => onOptionsChange({ ...options, sourceLanguage: e.currentTarget.value })}
                  disabled={busy || undefined}
                >
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.name}
                    </option>
                  ))}
                </select>
                <span className="job-lang-label">Target languages</span>
                <div className="job-lang-chips">
                  {LANGUAGE_OPTIONS.filter((l) => l.code !== options.sourceLanguage).map((lang) => {
                    const on = options.dubbingLanguages.includes(lang.code);
                    return (
                      <button
                        key={lang.code}
                        type="button"
                        className={`job-lang-chip${on ? " job-lang-chip--on" : ""}`}
                        onClick={() => toggleDubbingLang(lang.code, !on)}
                        disabled={busy || undefined}
                      >
                        {lang.name}
                      </button>
                    );
                  })}
                </div>
                <p className="job-lang-hint">
                  {options.dubbingLanguages.length === 0
                    ? "Select at least one target language"
                    : `${options.dubbingLanguages.length} dub${options.dubbingLanguages.length === 1 ? "" : "s"}`}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
