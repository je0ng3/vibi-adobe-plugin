const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ko: "Korean",
  ja: "Japanese",
  zh: "Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
  hi: "Hindi",
  vi: "Vietnamese",
};

function geminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export async function geminiTranslate(texts: string[], targetLang: string): Promise<string[]> {
  if (texts.length === 0) return [];
  const prompt =
    `Translate each subtitle line into ${languageName(targetLang)}.\n` +
    `Input is a JSON array of strings. Return ONLY a JSON array of translated strings, ` +
    `same length and order, no extra commentary.\n\n` +
    JSON.stringify(texts);

  const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${geminiApiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const parsed = parseJsonArray(raw);
  if (parsed.length !== texts.length) {
    // Length mismatch — fall back to originals to keep timing aligned.
    return texts.map((t, i) => parsed[i] ?? t);
  }
  return parsed;
}

function parseJsonArray(raw: string): string[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) return arr.map((x) => String(x));
  } catch {
    // ignore
  }
  return [];
}
