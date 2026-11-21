import { Candidate, EngineError } from "./core";
import { canUse } from "./engines";
import { callTool } from "./responses";

// Text work (the Urdu rewrite, script conversion) and reading pages, done by
// the gpt-6.2 models through tool calls.

// The 6.2 reasoning models, fastest tier first. Only the ones the API key
// actually has are used; when this was written that was gpt-6.2-sol alone.
const TEXT_MODELS = ["gpt-6.2-luna", "gpt-6.2-terra", "gpt-6.2-sol"];

// Readers of page pictures, best first. Measured on seven damaged Urdu
// pages (blurred, faded, torn, photographed at an angle, low resolution),
// words found on average: gpt-6.2-sol 83%, gpt-6.2-astra 75%, gpt-6.1-terra
// 62%. Those three also say honestly when a page is hard or unreadable.
// gpt-4.1-mini is left out on purpose: it found 54%, made up the rest and
// called every page "clear".
const PAGE_READERS = ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra"];

const SAVE_TEXT = {
  name: "save_text",
  description: "Saves the finished text.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The finished text." },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

const SAVE_PAGE = {
  name: "save_page_text",
  description: "Saves the text read from the page.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text of the page." },
      legibility: {
        type: "string",
        enum: ["clear", "hard", "unreadable"],
        description:
          "clear: every word could be read with confidence. hard: some words were guessed from their shape or the sentence, or could not be read. unreadable: most of the page could not be read.",
      },
    },
    required: ["text", "legibility"],
    additionalProperties: false,
  },
};

export type Legibility = "clear" | "hard" | "unreadable";
export type PageReading = { text: string; legibility: Legibility };

// `accept` checks the model's text; throwing there makes the router move on
// to the next model, so a bad answer is never returned.
export function textCandidates<T>(
  system: string,
  user: string,
  accept: (text: string) => T
): Candidate<T>[] {
  return TEXT_MODELS.map((model) => ({
    id: `text:${model}`,
    label: model,
    available: () => canUse(model),
    run: async () => {
      const { text } = await callTool<{ text?: unknown }>({
        model,
        instructions: `${system}\n\nGive the result by calling the save_text tool.`,
        input: user,
        tool: SAVE_TEXT,
      });
      if (typeof text !== "string" || !text.trim()) {
        throw new EngineError(`${model} returned no text`);
      }
      return accept(text.trim());
    },
  }));
}

// Reads the text off pictures of one page (data: URLs).
export function pageCandidates<T>(
  instructions: string,
  imageUrls: string[],
  accept: (reading: PageReading) => T
): Candidate<T>[] {
  return PAGE_READERS.map((model) => ({
    id: `read:${model}`,
    label: model,
    available: () => canUse(model),
    run: async () => {
      const reading = await callTool<Partial<PageReading>>({
        model,
        input: [
          { type: "input_text", text: instructions },
          ...imageUrls.map((image_url) => ({
            type: "input_image" as const,
            image_url,
            detail: "high" as const,
          })),
        ],
        tool: SAVE_PAGE,
        timeoutMs: 120_000,
      });
      if (typeof reading.text !== "string") {
        throw new EngineError(`${model} returned no page text`);
      }
      const legibility: Legibility =
        reading.legibility === "clear" || reading.legibility === "unreadable"
          ? reading.legibility
          : "hard";
      return accept({ text: reading.text.trim(), legibility });
    },
  }));
}
