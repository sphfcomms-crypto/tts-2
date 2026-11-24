import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gpuKey } from "./avatarGpu";

// The link to the whole-face server (avatar-flash/server.py): the GPU
// program that draws her head and shoulders new for every picture of a
// live call. Like the lip-sync box it is rented by the hour and gets a new
// address every time it starts, so it tells the app where it is
// (POST /api/avatar/flash/register) with the same shared secret. The video
// never passes through this app: the browser is given the address and a
// short-lived signed token and talks to the box itself.

const FILE = path.join(os.tmpdir(), "tts-avatar-flash.json");
const ALLOWED_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;

type Health = {
  ok: boolean;
  slice_frames?: number;
  look_frames?: number;
  fps?: number;
  work_seconds?: number;
  square?: number[];
  width?: number;
  height?: number;
  own_look?: boolean;
  idle_frames?: number;
  badge?: string;
};
export type FlashAccess = {
  url: string;
  token: string;
  sliceFrames: number;
  lookFrames: number;
  fps: number;
  workSeconds: number; // what drawing one slice costs the server; 0 when it does not say
  // The square of the frame the model draws, and the frame's size (absent
  // when the server does not say: an older one).
  square?: [number, number, number];
  width?: number;
  height?: number;
  // The server draws her in a look of its own, not the app's filmed one:
  // its frames are shown whole, and its loop of her listening quietly
  // (GET /idle.mp4, idleFrames pictures) plays between calls.
  ownLook?: { idleFrames: number; badge: string };
};

let address: string | null = null; // null: not read from disk yet
let cached: { at: number; value: Health | null } | null = null;
let checking: Promise<Health | null> | null = null;

function clean(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_HOST.test(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function flashAddress(): string {
  // While developing, a server on this machine can be named in .env. The
  // public server never reads this.
  if (process.env.NODE_ENV !== "production" && process.env.AVATAR_FLASH_URL) {
    return process.env.AVATAR_FLASH_URL;
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
export function setFlashAddress(url: string): boolean {
  const origin = clean(url);
  if (!origin) return false;
  address = origin;
  cached = null;
  try {
    fs.writeFileSync(FILE, JSON.stringify({ url: origin }), { mode: 0o600 });
  } catch (err) {
    console.error("Could not save the whole-face server address:", err);
  }
  return true;
}

// Whether the server answers right now. Asked at most every few seconds,
// and a server that is asleep never holds up the page's status check.
function health(): Promise<Health | null> {
  const base = flashAddress();
  if (!base || !gpuKey()) return Promise.resolve(null);
  if (cached && Date.now() - cached.at < 8000) return Promise.resolve(cached.value);
  if (!checking) {
    checking = (async () => {
      let value: Health | null = null;
      try {
        const res = await fetch(`${base}/health`, {
          headers: { "x-avatar-key": gpuKey() },
          signal: AbortSignal.timeout(4000),
          cache: "no-store",
        });
        if (res.ok) {
          const body = (await res.json()) as Health;
          if (body.ok && body.slice_frames && body.fps) value = body;
        }
      } catch {}
      cached = { at: Date.now(), value };
      checking = null;
      return value;
    })();
  }
  return cached && !cached.value ? Promise.resolve(null) : checking;
}

// What a browser needs to reach the server itself: its address, a token it
// accepts for the next quarter of an hour (the expiry time signed with the
// shared secret), and the length of the slices it draws.
export async function flashAccess(): Promise<FlashAccess | null> {
  const status = await health();
  const url = flashAddress();
  const key = gpuKey();
  if (!status || !url || !key) return null;
  const expires = String(Math.floor(Date.now() / 1000) + 15 * 60);
  const signature = createHmac("sha256", key).update(expires).digest("hex");
  const whole = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const square = status.square;
  const placed =
    Array.isArray(square) && square.length === 3 && square.every(whole) && square[2] > 0 &&
    whole(status.width) && whole(status.height) &&
    square[0] + square[2] <= status.width && square[1] + square[2] <= status.height;
  return {
    url,
    token: `${expires}.${signature}`,
    sliceFrames: status.slice_frames!,
    lookFrames: status.look_frames ?? 0,
    fps: status.fps!,
    workSeconds: status.work_seconds && status.work_seconds > 0 ? status.work_seconds : 0,
    ...(placed
      ? { square: [square[0], square[1], square[2]] as [number, number, number], width: status.width, height: status.height }
      : {}),
    ...(status.own_look === true && whole(status.idle_frames) && status.idle_frames > 0
      ? { ownLook: { idleFrames: Math.round(status.idle_frames), badge: typeof status.badge === "string" ? status.badge : "" } }
      : {}),
  };
}
