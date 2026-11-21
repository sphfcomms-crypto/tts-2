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
let health: { at: number; value: Health | null } | null = null;

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
  health = null;
  try {
    fs.writeFileSync(FILE, JSON.stringify({ url: origin }), { mode: 0o600 });
  } catch (err) {
    console.error("Could not save the avatar GPU address:", err);
  }
  return true;
}

// Whether the box answers right now. Asked at most every few seconds.
export async function gpuHealth(): Promise<Health | null> {
  const base = gpuAddress();
  if (!base || !gpuKey()) return null;
  if (health && Date.now() - health.at < 8000) return health.value;
  let value: Health | null = null;
  try {
    const res = await fetch(`${base}/health`, {
      headers: { "x-avatar-key": gpuKey() },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const body = (await res.json()) as Health;
      value = body.ok ? body : null;
    }
  } catch {}
  health = { at: Date.now(), value };
  return value;
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
export async function gpuSpeak(
  wav: Uint8Array,
  start: number,
  {
    clip = "talk",
    lead = 0,
    sound = true,
    signal,
  }: { clip?: string; lead?: number; sound?: boolean; signal?: AbortSignal } = {}
): Promise<{ video: Uint8Array; next: number }> {
  const base = gpuAddress();
  if (!base) throw new Error("the avatar GPU is not connected");
  const query =
    `clip=${clip}&start=${start}` +
    (lead ? `&lead_ms=${lead}` : "") +
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
    health = null;
    throw new Error(`the avatar GPU answered ${res.status}`);
  }
  const video = new Uint8Array(await res.arrayBuffer());
  const next = Number(res.headers.get("x-next-start"));
  return { video, next: Number.isFinite(next) ? next : 0 };
}
