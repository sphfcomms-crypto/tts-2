import { withRendererPreference } from "./rendererPreference";
import { avatarBus, type Direct, type Stage } from "./bus";
import { FPS } from "./director";
import { getClipTimeline } from "../streamPlayer";
import { scriptedShots, type ScriptShot } from "./scriptedShots";

const RATE = 24000;
const PER_FRAME = RATE / FPS;
// Fits both the old and new relay's 200 kB request limit with context.
const CHUNK_FRAMES = 90;
const CONTEXT = RATE / 5;
const movies = new WeakMap<Blob, Blob>();
let encoderRegistered = false;

// Every chunk begins on a video frame. The last frame can extend beyond
// the final audio sample by less than one frame period.
export function renderWindows(samples: number, shots: readonly ScriptShot[]) {
  const windows = [];
  for (const shot of shots) {
    for (let sourceFrame = 0; sourceFrame < shot.frames; sourceFrame += CHUNK_FRAMES) {
      const frames = Math.min(CHUNK_FRAMES, shot.frames - sourceFrame);
      const frame = shot.frame + sourceFrame;
      const start = frame * PER_FRAME;
      const end = Math.min(samples, (frame + frames) * PER_FRAME);
      const lead = Math.min(start, CONTEXT);
      // Neighbouring sound supplies context even across a change of gesture.
      const tail = Math.floor(Math.min(samples - end, CONTEXT) / (RATE / 1000)) * (RATE / 1000);
      windows.push({ clip: shot.clip, sourceFrame, frame, frames, start, end, lead, tail });
    }
  }
  return windows;
}

function wav(samples: Float32Array) {
  const body = new Uint8Array(44 + 2 * samples.length);
  const v = new DataView(body.buffer);
  const write = (at: number, text: string) => body.set(new TextEncoder().encode(text), at);
  write(0, "RIFF"); v.setUint32(4, body.length - 8, true);
  write(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  write(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
  }
  return body;
}

function directUrl(direct: Direct, clip: string, start: number, lead: number, tail: number) {
  const query = new URLSearchParams({
    clip, start: String(start), lead_ms: String(lead), tail_ms: String(tail),
    audio: "0", t: direct.token,
  });
  return `${direct.url}/speak?${query}`;
}

export async function needsBuffer(stage: Stage, clip: Blob | null, signal: AbortSignal) {
  if (clip && movies.has(clip)) return true;
  const direct = avatarBus.direct;
  if (!direct) return true;
  // A URL in the registration doesn't prove this browser can POST to it.
  // A direct 400 ms render must fit well inside the live path's playout delay.
  try {
    const res = await fetch(directUrl(direct, stage.director.scriptedClip.name, 0, 0, 0), {
      method: "POST", body: new Blob([wav(new Float32Array(RATE * 0.4))]),
      signal: AbortSignal.any([signal, AbortSignal.timeout(900)]),
    });
    return !res.ok || (await res.arrayBuffer()).byteLength === 0;
  } catch {
    signal.throwIfAborted();
    return true;
  }
}

export async function bufferedMovie(clip: Blob, stage: Stage, signal: AbortSignal) {
  const cached = movies.get(clip);
  if (cached) return cached;
  const [media, flac, audio] = await Promise.all([
    import("mediabunny"), import("@mediabunny/flac-encoder"),
    clip.arrayBuffer().then(bytes => new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes)),
  ]);
  signal.throwIfAborted();
  if (!encoderRegistered) {
    flac.registerFlacEncoder();
    encoderRegistered = true;
  }

  const samples = audio.getChannelData(0);
  const timeline = getClipTimeline(clip);
  const shots = scriptedShots(samples, RATE, stage.director.units, stage.director.scriptedClip,
    seconds => timeline?.phraseAt(seconds) ?? "");
  const videoTrack = new media.EncodedVideoPacketSource("avc");
  const voice = new media.AudioBufferSource({ codec: "flac" });
  const out = new media.Output({ format: new media.Mp4OutputFormat(), target: new media.BufferTarget() });
  out.addVideoTrack(videoTrack, { frameRate: FPS });
  out.addAudioTrack(voice);
  await out.start();

  // Audio is losslessly encoded once for the ENTIRE shot. Each independently
  // rendered GPU piece contributes only pictures, avoiding a new AAC priming
  // delay and a clipped syllable at every join.
  const requests = new AbortController();
  const drawSignal = AbortSignal.any([signal, requests.signal]);
  async function picture() {
    for (const win of renderWindows(samples.length, shots)) {
      signal.throwIfAborted();
      if (!stage.director.running) throw new Error("Video stage closed");
      const lead = win.lead / (RATE / 1000), tail = win.tail / (RATE / 1000);
      const query = new URLSearchParams({ clip: win.clip, start: String(win.sourceFrame), lead: String(lead), tail: String(tail) });
      const response = await fetch(withRendererPreference(`/api/avatar/chunk?${query}`), {
        method: "POST", headers: { "Content-Type": "audio/wav" },
        body: wav(samples.subarray(win.start - win.lead, win.end + win.tail)),
        signal: AbortSignal.any([drawSignal, AbortSignal.timeout(90000)]),
      });
      if (!response.ok) throw new Error(`Avatar render failed (${response.status})`);
      const input = new media.Input({ formats: [media.MP4], source: new media.BlobSource(await response.blob()) });
      try {
        const track = await input.getPrimaryVideoTrack();
        const config = await track?.getDecoderConfig();
        if (!track || !config) throw new Error("Missing avatar video track");
        let frame = 0;
        for await (const packet of new media.EncodedPacketSink(track).packets()) {
          // Older relay versions draw the optional tail too. It supplies
          // lookahead for the model but never gets a second place on screen.
          if (frame >= win.frames) break;
          signal.throwIfAborted();
          const pts = (win.frame + frame) / FPS;
          await videoTrack.add(packet.clone({ timestamp: pts, duration: 1 / FPS }),
            frame === 0 ? { decoderConfig: config } : undefined);
          frame++;
        }
        if (frame !== win.frames) throw new Error("Avatar video ended early");
      } finally {
        input.dispose();
      }
    }
    videoTrack.close();
  }
  try {
    await Promise.all([picture(), voice.add(audio).then(() => voice.close())]);
    signal.throwIfAborted();
    await out.finalize();
    const movie = new Blob([out.target.buffer!], { type: "video/mp4" });
    movies.set(clip, movie);
    return movie;
  } catch (error) {
    requests.abort();
    await out.cancel().catch(() => {});
    throw error;
  }
}

// Keep the element muted until its own first full frame is ready to show.
// The native player's two tracks share a seek, pause, decoder and media clock.
export async function playMovie(
  movie: Blob, stage: Stage, signal: AbortSignal, onPlay: () => void,
  onFallback: (secondsPlayed: number) => void
) {
  signal.throwIfAborted();
  const video = stage.video;
  const url = URL.createObjectURL(movie);
  const events = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      const options = { once: true, signal: events.signal };
      const stopped = () => reject(signal.reason);
      signal.addEventListener("abort", stopped, options);
      video.addEventListener("error", () => reject(new Error("The avatar movie could not play")), options);
      video.addEventListener("ended", () => resolve(), options);
      video.addEventListener("timeupdate", () => {
        if (!stage.director.running) reject(new Error("Video stage closed"));
      }, { signal: events.signal });
      video.addEventListener("loadeddata", () => {
        if (!stage.director.running) {
          reject(new Error("Video stage closed"));
          return;
        }
        stage.speaking(true);
        stage.talking(true);
        video.muted = false;
        video.playbackRate = 1;
        video.play().then(() => { if (!signal.aborted) onPlay(); }, reject);
      }, options);
      video.src = url;
      video.load();
    });
  } catch (error) {
    if (!signal.aborted) onFallback(video.currentTime);
    throw error;
  } finally {
    events.abort();
    if (video.getAttribute("src") === url) {
      video.pause();
      video.muted = true;
      video.removeAttribute("src");
      video.load();
      stage.speaking(false);
      stage.talking(false);
    }
    URL.revokeObjectURL(url);
  }
}
