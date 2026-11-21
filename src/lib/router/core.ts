// The routing engine. Each job the app does (rewriting text, speaking,
// transcribing) has an ordered list of engines that can do it, best first.
// route() picks the best one that is installed and healthy, and moves on to
// the next the moment one fails, so a missing key, a dead server or a model
// the account cannot use never reaches the user as an error.

export type Capability =
  | "text"
  | "speech"
  | "transcribe"
  | "check"
  | "call"
  | "read";

export type Candidate<T> = {
  id: string;
  label: string;
  // Is this engine installed / configured at all? (cheap, cached checks)
  available: () => Promise<boolean> | boolean;
  run: () => Promise<T>;
};

export class EngineError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

type Health = {
  strikes: number;
  downUntil: number;
  lastError?: string;
  lastOkAt?: number;
  lastLatencyMs?: number;
  uses: number;
};

type LastUsed = { id: string; label: string; at: number };

const store = globalThis as unknown as {
  __routerHealth?: Map<string, Health>;
  __routerLastUsed?: Map<Capability, LastUsed>;
};
const health = (store.__routerHealth ??= new Map());
const lastUsed = (store.__routerLastUsed ??= new Map());

const entry = (id: string): Health => {
  let item = health.get(id);
  if (!item) {
    item = { strikes: 0, downUntil: 0, uses: 0 };
    health.set(id, item);
  }
  return item;
};

export const isDown = (id: string) => entry(id).downUntil > Date.now();

export function reportSuccess(id: string, latencyMs: number) {
  const item = entry(id);
  item.strikes = 0;
  item.downUntil = 0;
  item.lastError = undefined;
  item.lastOkAt = Date.now();
  item.lastLatencyMs = Math.round(latencyMs);
  item.uses += 1;
}

// A failed engine is skipped for a while: 30 s at first, doubling up to five
// minutes. A rejected key or a model the account may not use will not fix
// itself in seconds, so those rest for ten minutes.
export function reportFailure(id: string, err: unknown) {
  const item = entry(id);
  const status = err instanceof EngineError ? err.status : undefined;
  item.strikes += 1;
  const rest =
    status === 401 || status === 403 || status === 404
      ? 10 * 60_000
      : status === 429
      ? 60_000
      : Math.min(30_000 * 2 ** (item.strikes - 1), 5 * 60_000);
  item.downUntil = Date.now() + rest;
  item.lastError = (err instanceof Error ? err.message : String(err)).slice(
    0,
    200
  );
  console.warn(
    `[router] ${id} failed (${item.lastError}); resting ${Math.round(
      rest / 1000
    )}s`
  );
}

export const markUsed = (capability: Capability, id: string, label: string) =>
  lastUsed.set(capability, { id, label, at: Date.now() });

async function isAvailable(candidate: Candidate<unknown>): Promise<boolean> {
  try {
    return await candidate.available();
  } catch {
    return false;
  }
}

// Engines to try, in order: installed and healthy first; engines that are
// resting after a failure are kept as a last resort rather than dropped.
export async function order<T>(
  candidates: Candidate<T>[]
): Promise<Candidate<T>[]> {
  const installed: Candidate<T>[] = [];
  for (const candidate of candidates) {
    if (await isAvailable(candidate)) installed.push(candidate);
  }
  return [
    ...installed.filter((c) => !isDown(c.id)),
    ...installed.filter((c) => isDown(c.id)),
  ];
}

export async function route<T>(
  capability: Capability,
  candidates: Candidate<T>[]
): Promise<{ value: T; engine: { id: string; label: string } }> {
  let lastError: unknown;

  for (const candidate of await order(candidates)) {
    const started = Date.now();
    try {
      const value = await candidate.run();
      reportSuccess(candidate.id, Date.now() - started);
      markUsed(capability, candidate.id, candidate.label);
      return { value, engine: { id: candidate.id, label: candidate.label } };
    } catch (err) {
      // A 422 means this one input went wrong on this engine (a bad take),
      // which says nothing about the engine's health: move on, no rest.
      if (err instanceof EngineError && err.status === 422) {
        console.warn(`[router] ${err.message}`);
      } else {
        reportFailure(candidate.id, err);
      }
      lastError = err;
    }
  }

  throw new EngineError(
    `No ${capability} engine is working` +
      (lastError instanceof Error ? `: ${lastError.message}` : "."),
    503
  );
}

export async function describe(
  capability: Capability,
  candidates: Candidate<unknown>[]
) {
  const engines = [];
  for (const candidate of candidates) {
    const item = entry(candidate.id);
    const installed = await isAvailable(candidate);
    engines.push({
      id: candidate.id,
      label: candidate.label,
      state: !installed ? "missing" : isDown(candidate.id) ? "resting" : "ready",
      lastError: item.lastError,
      lastLatencyMs: item.lastLatencyMs,
      uses: item.uses,
    });
  }
  const next = engines.find((e) => e.state === "ready") ?? null;
  return {
    capability,
    next: next && { id: next.id, label: next.label },
    lastUsed: lastUsed.get(capability) ?? null,
    engines,
  };
}
