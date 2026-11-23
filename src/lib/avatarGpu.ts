import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The link to the GPU box that draws her speaking on video.
//
// The box is rented by the hour and gets a new public address every time it
// starts, so it tells the app where it is (POST /api/avatar/register). The
// address is remembered across restarts of the app. Every call in either
// direction carries the shared secret AVATAR_GPU_KEY.
//
// The video itself does not pass through this app when it can be helped:
// the app is reached through a relay that was measured to carry it slower
// than it plays. The browser is given the box's address and a short-lived
// signed token instead (never the secret), and fetches the video from the
// box directly.

const FILE = path.join(os.tmpdir(), "tts-avatar-gpu.json");
// Only addresses of the tunnel service the box uses are accepted, so the
// app can never be pointed at some other server.
const ALLOWED_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;

export type Clip = { name: string; frames: number; fps: number; width: number; height: number };
export type Health = { ok: boolean; model?: string; clips?: Clip[] };

let address: string | null = null; // null: not read from disk yet
const LOCAL_RENDERER = "http://127.0.0.1:8191";
export type Renderer = { base: string; health: Health; kind: "gpu" | "cpu" };
const healthCache = new Map<string, { at: number; value: Health | null }>();
const checking = new Map<string, Promise<Health | null>>();

export const gpuKey = () => process.env.AVATAR_GPU_KEY || "";

export function keyMatches(given: string | null): boolean {
  const key = gpuKey();
  if (!key || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clean(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_HOST.test(parsed.hostname)) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function gpuAddress(): string {
  // While developing, a stand-in server on this machine can be named in
  // .env. The public server never reads this.
  if (process.env.NODE_ENV !== "production" && process.env.AVATAR_GPU_URL) {
    return process.env.AVATAR_GPU_URL;
  }
  if (address === null) {
    try {
      address = clean(JSON.parse(fs.readFileSync(FILE, "utf8")).url) ?? "";
    } catch {
      address = "";
    }
  }
  return address;
}

// Returns false when the address is not one the app accepts.
export function setGpuAddress(url: string): boolean {
  const origin = clean(url);
  if (!origin) return false;
  address = origin;
  healthCache.clear();
  try {
    fs.writeFileSync(FILE, JSON.stringify({ url: origin }), { mode: 0o600 });
  } catch (err) {
    console.error("Could not save the avatar GPU address:", err);
  }
  return true;
}

// The CPU performer is on the same VPS as Next. The rental can go to
// sleep without changing the public call URL or the clip/frame numbering.
function readHealth(base: string): Promise<Health | null> {
  if (!base || !gpuKey()) return Promise.resolve(null);
  const cached = healthCache.get(base);
  if (cached && Date.now() - cached.at < 8000) return Promise.resolve(cached.value);
  let pending = checking.get(base);
  if (!pending) {
    pending = (async () => {
      let value: Health | null = null;
      try {
        const response = await fetch(`${base}/health`, {
          headers: { "x-avatar-key": gpuKey() },
          signal: AbortSignal.timeout(base === LOCAL_RENDERER ? 750 : 4000),
          cache: "no-store",
        });
        if (response.ok) {
          const result: Health = await response.json();
          if (result.ok && result.clips?.length) value = result;
        }
      } catch {}
      healthCache.set(base, { value, at: Date.now() });
      checking.delete(base);
      return value;
    })();
    checking.set(base, pending);
  }
  // An asleep rental should never block each eighth second of an ongoing
  // CPU-backed conversation while its tunnel is rechecked.
  return cached && !cached.value ? Promise.resolve(null) : pending;
}

export async function rendererFor(clip?: string, localOnly = false): Promise<Renderer | null> {
  const matches = (status: Health | null) =>
    status && (!clip || status.clips?.some(unit => unit.name === clip));
  if (!localOnly) {
    const base = gpuAddress();
    const health = await readHealth(base);
    if (health && matches(health)) return { base, health, kind: "gpu" };
  }
  const health = await readHealth(LOCAL_RENDERER);
  return health && matches(health) ? { base: LOCAL_RENDERER, health, kind: "cpu" } : null;
}

// What a browser needs to reach the box itself: its address, and a token
// the box accepts for the next quarter of an hour. The token is the expiry
// time signed with the shared secret.
export function browserAccess(): { url: string; token: string } | null {
  const url = gpuAddress();
  const key = gpuKey();
  if (!url || !key) return null;
  const expires = String(Math.floor(Date.now() / 1000) + 15 * 60);
  const signature = createHmac("sha256", key).update(expires).digest("hex");
  return { url, token: `${expires}.${signature}` };
}

// A piece of her speech (a WAV file) in, video of her saying it out, drawn
// on the frames of `clip` from frame `start` on.
// `lead` milliseconds at the start of the WAV are earlier sound, given only
// as context: they are not drawn. With `sound: false` the video comes back
// silent (a live call plays her voice itself).
export async function renderSpeech(
  renderer: Renderer,
  wav: Uint8Array,
  start: number,
  {
    clip = "talk",
    lead = 0,
    tail = 0,
    sound = true,
    signal,
  }: { clip?: string; lead?: number; tail?: number; sound?: boolean; signal?: AbortSignal } = {}
): Promise<{ video: Uint8Array; next: number }> {
  const { base } = renderer;
  const query =
    `clip=${clip}&start=${start}` +
    (lead ? `&lead_ms=${lead}` : "") +
    (tail ? `&tail_ms=${tail}` : "") +
    (sound ? "" : "&audio=0");
  const res = await fetch(`${base}/speak?${query}`, {
    method: "POST",
    headers: { "x-avatar-key": gpuKey(), "Content-Type": "audio/wav" },
    body: new Uint8Array(wav),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(90_000)])
      : AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    healthCache.delete(base);
    throw new Error(`avatar renderer answered ${res.status}`);
  }
  const video = new Uint8Array(await res.arrayBuffer());
  const next = Number(res.headers.get("x-next-start"));
  return { video, next: Number.isFinite(next) ? next : 0 };
}
