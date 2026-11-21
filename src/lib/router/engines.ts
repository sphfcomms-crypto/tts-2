import { EngineError } from "./core";

// Everything runs on OpenAI. The router asks the account which models it
// can use and only routes to those, so nothing here needs configuring.

export const OPENAI_BASE = (
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
).replace(/\/+$/, "");

export const REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  "wss://api.openai.com/v1/realtime?intent=transcription";

export const openaiKey = () => (process.env.OPENAI_API_KEY || "").trim();
export const hasOpenAI = () => openaiKey().length > 0;

export const openaiHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${openaiKey()}`,
});

// Turns a failed HTTP response into an error the router can grade.
export async function failed(res: Response, what: string): Promise<never> {
  let detail = "";
  try {
    const text = await res.text();
    detail = JSON.parse(text)?.error?.message ?? text;
  } catch {}
  throw new EngineError(
    `${what} answered ${res.status}${
      detail ? `: ${String(detail).slice(0, 160)}` : ""
    }`,
    res.status
  );
}

let modelCache: { ids: Set<string> | null; expires: number } | null = null;
let modelLoad: Promise<Set<string> | null> | null = null;

// The model ids this API key can use, or null when the list could not be
// fetched (then every model is tried and failures sort it out).
async function accountModels(): Promise<Set<string> | null> {
  if (modelCache && Date.now() < modelCache.expires) return modelCache.ids;

  modelLoad ??= (async () => {
    let ids: Set<string> | null = null;
    try {
      const res = await fetch(`${OPENAI_BASE}/models`, {
        headers: openaiHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const body = await res.json();
        ids = new Set((body.data ?? []).map((m: { id: string }) => m.id));
      }
    } catch {}
    // A good list is kept for ten minutes; a failed fetch is retried soon.
    modelCache = { ids, expires: Date.now() + (ids ? 10 * 60_000 : 30_000) };
    return ids;
  })().finally(() => {
    modelLoad = null;
  });
  return modelLoad;
}

// Can this key use the model? Unknown counts as yes.
export async function canUse(model: string): Promise<boolean> {
  if (!hasOpenAI()) return false;
  const ids = await accountModels();
  return ids ? ids.has(model) : true;
}
