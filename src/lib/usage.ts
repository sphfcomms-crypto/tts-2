// Spend guard for when the app is reachable from the internet. Every Play,
// rewrite and mic session costs money on the OpenAI key, so the production
// server caps how many each visitor and everyone together may start. The
// counts live in memory and reset when the server restarts. Development is
// not limited.
//
// To change a cap, set e.g. LIMIT_SPEECH_PER_DAY=1000 in .env. To switch the
// guard off, set USAGE_LIMITS=off.

type Kind = "speech" | "text" | "mic" | "call" | "file" | "video";

const DEFAULTS: Record<Kind, { perVisitorPerHour: number; perDay: number }> = {
  speech: { perVisitorPerHour: 40, perDay: 500 },
  text: { perVisitorPerHour: 80, perDay: 1000 },
  mic: { perVisitorPerHour: 15, perDay: 150 },
  // A call is billed by the minute while it is connected, so few are allowed.
  call: { perVisitorPerHour: 6, perDay: 60 },
  // Uploaded recordings to transcribe.
  file: { perVisitorPerHour: 10, perDay: 100 },
  // Chunks of her live-call voice sent to the GPU to be drawn: several a
  // second for as long as she is speaking.
  video: { perVisitorPerHour: 6000, perDay: 40000 },
};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const store = globalThis as unknown as {
  __usage?: Map<string, number[]>;
};
const events = (store.__usage ??= new Map());

const enabled = () =>
  process.env.NODE_ENV === "production" && process.env.USAGE_LIMITS !== "off";

function limit(kind: Kind, field: "perVisitorPerHour" | "perDay"): number {
  const name =
    field === "perDay"
      ? `LIMIT_${kind.toUpperCase()}_PER_DAY`
      : `LIMIT_${kind.toUpperCase()}_PER_VISITOR_HOUR`;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULTS[kind][field];
}

// Counts the events of a key inside the window, dropping older ones.
function recent(key: string, windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  const kept = (events.get(key) ?? []).filter((time: number) => time > cutoff);
  events.set(key, kept);
  return kept;
}

// The visitor's address. Tailscale Funnel and other proxies put the real
// one in X-Forwarded-For; a direct connection has none.
function visitor(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "direct"
  );
}

// Records one use and says whether it is allowed. Returns a 429 response to
// send back when a cap has been reached, or null to carry on.
export function overLimit(kind: Kind, req: Request): Response | null {
  if (!enabled()) return null;

  const visitorKey = `${kind}:visitor:${visitor(req)}`;
  const dayKey = `${kind}:everyone`;
  const byVisitor = recent(visitorKey, HOUR);
  const byEveryone = recent(dayKey, DAY);

  if (
    byVisitor.length >= limit(kind, "perVisitorPerHour") ||
    byEveryone.length >= limit(kind, "perDay")
  ) {
    console.warn(`[usage] ${kind} limit reached for ${visitor(req)}`);
    return new Response("Usage limit reached. Please try again later.", {
      status: 429,
      headers: { "Retry-After": "600" },
    });
  }

  const now = Date.now();
  byVisitor.push(now);
  byEveryone.push(now);
  return null;
}
