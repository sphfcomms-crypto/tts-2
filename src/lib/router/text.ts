import { Candidate, EngineError } from "./core";
import { OPENAI_BASE, canUse, failed, openaiHeaders } from "./engines";

// Chat models that can do the Roman Urdu rewrite, best first for this job:
// fast, cheap models that write Urdu well, then bigger ones as backup.
const TEXT_MODELS = [
  "gpt-4.1-mini",
  "gpt-4o-mini",
  "gpt-5.4-mini",
  "gpt-4.1",
  "gpt-4o",
  "gpt-5-mini",
];

// Models trusted to read a picture of a page. Only these: measured on Urdu
// Nastaliq pages, gpt-4.1-mini got 95 to 100% of the words right, while
// gpt-4o-mini, gpt-4o, gpt-4.1, gpt-5.4-mini and gpt-5.4 made up sentences
// (16 to 90%). A wrong reader is worse than none, so there is no wider
// fallback here.
const PAGE_READERS = ["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"];

const TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 90_000;

// Reasoning models reject a custom temperature and are slow unless told to
// think little; the older chat models take a temperature instead.
const isReasoningModel = (model: string) => /^(gpt-[5-9]|o\d)/.test(model);

type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

async function complete(
  model: string,
  system: string,
  user: string | Part[],
  temperature = 0.4,
  timeoutMs = TIMEOUT_MS
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    response_format: { type: "json_object" },
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    ...(isReasoningModel(model)
      ? { reasoning_effort: "low" }
      : { temperature }),
  };

  const send = () =>
    fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { ...openaiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  let res = await send();

  // A model that refuses one of the tuning knobs still gets a plain try.
  if (res.status === 400) {
    const text = await res.clone().text();
    if (/temperature|reasoning_effort/.test(text)) {
      delete body.temperature;
      delete body.reasoning_effort;
      res = await send();
    }
  }

  if (!res.ok) await failed(res, model);

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new EngineError(`${model} returned no text`);
  }
  return content;
}

// `accept` checks and unpacks the model's answer; throwing there makes the
// router move on to the next model, so a bad answer is never returned.
export function textCandidates<T>(
  system: string,
  user: string,
  accept: (content: string) => T
): Candidate<T>[] {
  const override = process.env.OPENAI_TEXT_MODEL;
  const models = override
    ? [override, ...TEXT_MODELS.filter((m) => m !== override)]
    : TEXT_MODELS;

  return models.map((model) => ({
    id: `text:${model}`,
    label: model,
    available: () => canUse(model),
    run: async () => accept(await complete(model, system, user)),
  }));
}

// Reads the text off a picture of a page (a data: URL of a JPEG or PNG).
export function pageCandidates<T>(
  instructions: string,
  imageUrl: string,
  accept: (content: string) => T
): Candidate<T>[] {
  return PAGE_READERS.map((model) => ({
    id: `read:${model}`,
    label: model,
    available: () => canUse(model),
    run: async () =>
      accept(
        await complete(
          model,
          "",
          [
            { type: "text", text: instructions },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
          0,
          PAGE_TIMEOUT_MS
        )
      ),
  }));
}
