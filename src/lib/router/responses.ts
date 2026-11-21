import { EngineError } from "./core";
import { OPENAI_BASE, failed, openaiHeaders } from "./engines";

// One call to the OpenAI Responses API that must answer by calling a tool.
// The gpt-6 models only take function tools on this API, and a forced tool
// call gives the answer as checked fields instead of free text to parse.

export type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "high" };

export type Tool = {
  name: string;
  description: string;
  // JSON Schema of the arguments (an object with every property required).
  parameters: Record<string, unknown>;
};

export async function callTool<T = Record<string, unknown>>(options: {
  model: string;
  instructions?: string;
  input: string | InputPart[];
  tool: Tool;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
}): Promise<T> {
  const { model, tool } = options;
  const body: Record<string, unknown> = {
    model,
    ...(options.instructions && { instructions: options.instructions }),
    input:
      typeof options.input === "string"
        ? options.input
        : [{ role: "user", content: options.input }],
    tools: [{ type: "function", strict: true, ...tool }],
    tool_choice: { type: "function", name: tool.name },
    reasoning: { effort: options.effort ?? "low" },
    // Nothing here needs to be kept on OpenAI's side afterwards.
    store: false,
  };

  const send = () =>
    fetch(`${OPENAI_BASE}/responses`, {
      method: "POST",
      headers: { ...openaiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });

  let res = await send();

  // A model without reasoning settings still gets a plain try.
  if (res.status === 400) {
    const text = await res.clone().text();
    if (/reasoning/.test(text)) {
      delete body.reasoning;
      res = await send();
    }
  }
  if (!res.ok) await failed(res, model);

  const data = await res.json();
  const call = (data?.output ?? []).find(
    (item: { type?: string; name?: string }) =>
      item.type === "function_call" && item.name === tool.name
  );
  if (!call) throw new EngineError(`${model} did not call ${tool.name}`);
  try {
    return JSON.parse(call.arguments) as T;
  } catch {
    throw new EngineError(`${model} gave arguments that are not valid JSON`);
  }
}
