// A live call on the real page, without the voice model and without a GPU, to check that the
// whole-face video (src/lib/avatar/flashTalk.ts) keeps the picture on the sound being heard.
//
//   python flash_standin.py voice.wav &            # the stand-in video server, port 8100
//   AVATAR_GPU_KEY=test AVATAR_FLASH_URL=http://127.0.0.1:8100 npm run dev   # in the project folder
//   node flash_call.mjs out/flash 30               # press "Call her", record 30 s
//
// The page's request to start a call is answered here, inside the page, by a second peer
// connection that plays voice.wav as her voice: the page's own call code runs unchanged, on a real
// audio track. The stand-in server draws every picture as bright as the sound is loud, so the
// brightness on screen can be compared with the loudness at the loudspeaker.
//
// Writes <out>/samples.json (sixty times a second: time, loudness played, brightness shown,
// whether the stream is on screen), <out>/result.json and <out>/page.png.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");

const out = process.argv[2] || "out/flash";
const seconds = Number(process.argv[3] || 30);
const SITE = process.env.SITE || "http://localhost:3000";
const VOICE = process.env.VOICE_URL || "http://127.0.0.1:8100/voice.wav";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 880, height: 900 } });
await context.grantPermissions(["microphone"], { origin: new URL(SITE).origin });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("requestfailed", (req) => errors.push(`request failed: ${req.method()} ${req.url().slice(0, 120)} ${req.failure()?.errorText ?? ""}`));
page.on("dialog", (dialog) => {
  errors.push("alert: " + dialog.message());
  dialog.dismiss().catch(() => {});
});

await page.addInitScript(({ VOICE }) => {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/call")) return real(input, init);
    if ((init?.method || "GET") === "DELETE") return new Response("{}");
    // "Her": a peer in this same page that answers the call and speaks the recording.
    const { sdp } = JSON.parse(init.body);
    const her = new RTCPeerConnection();
    const audio = new AudioContext();
    const mouth = audio.createMediaStreamDestination();
    const recording = await audio.decodeAudioData(await (await real(VOICE)).arrayBuffer());
    her.ondatachannel = ({ channel }) => {
      channel.onopen = () => channel.send(JSON.stringify({ type: "session.started" }));
    };
    await her.setRemoteDescription({ type: "offer", sdp });
    her.addTrack(mouth.stream.getAudioTracks()[0], mouth.stream);
    await her.setLocalDescription(await her.createAnswer());
    await new Promise((done) => {
      if (her.iceGatheringState === "complete") return done();
      her.addEventListener("icegatheringstatechange", () => her.iceGatheringState === "complete" && done());
      setTimeout(done, 3000);
    });
    // She speaks the recording after five seconds of silence, and once more after a pause.
    for (const at of [5, 5 + recording.duration + 3]) {
      const line = audio.createBufferSource();
      line.buffer = recording;
      line.connect(mouth);
      line.start(audio.currentTime + at);
    }
    Object.assign(window, { __her: her, __herAudio: audio, __lineSeconds: recording.duration });
    return new Response(JSON.stringify({ sessionId: "test", sdp: her.localDescription.sdp, maxSeconds: 600 }),
      { headers: { "Content-Type": "application/json" } });
  };
}, { VOICE });

await page.goto(SITE, { waitUntil: "domcontentloaded" });
// Her clips load first: the call waits for the stage anyway, but the page must have asked for it.
await page.waitForFunction(() => document.querySelectorAll("video").length >= 3, null, { timeout: 60000 });
await page.getByRole("button", { name: /call her/i }).click();
await page.waitForFunction(() => window.__flash, null, { timeout: 30000 }).catch(() => {});
const started = await page.evaluate(() => Boolean(window.__flash));

if (started) {
  await page.evaluate(() => {
    const flash = window.__flash;
    const context = flash.context;
    const meter = context.createAnalyser();
    meter.fftSize = 2048;
    flash.delay.connect(meter);            // what goes to the loudspeaker
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const pen = canvas.getContext("2d", { willReadFrequently: true });
    const wave = new Float32Array(meter.fftSize);
    const video = flash.stage.video;
    window.__samples = [];
    const look = () => {
      meter.getFloatTimeDomainData(wave);
      let power = 0;
      const n = Math.round(context.sampleRate * 0.02);
      for (let i = wave.length - n; i < wave.length; i++) power += wave[i] * wave[i];
      pen.drawImage(video, 0, 0, 4, 4);
      window.__samples.push([performance.now(), Math.sqrt(power / n), pen.getImageData(1, 1, 1, 1).data[0],
        Number(getComputedStyle(video).opacity), video.currentTime, flash.delay.delayTime.value]);
      requestAnimationFrame(look);
    };
    look();
  });
  // INTERRUPT_AT=<seconds>: the caller cuts her off then (what she had not yet been heard to say is dropped).
  if (process.env.INTERRUPT_AT) {
    await page.evaluate((after) => setTimeout(() => window.__flash.interrupt(), after * 1000), Number(process.env.INTERRUPT_AT));
  }
  await page.waitForTimeout(seconds * 1000);
}

const samples = started ? await page.evaluate(() => window.__samples) : [];
const describe = started ? await page.evaluate(() => window.__flash.describe()) : null;
await page.screenshot({ path: path.join(out, "page.png") });
// Hang up: the page must give the loudspeaker back and stop the stream.
await page.getByRole("button", { name: /end call/i }).click().catch(() => {});
await page.waitForTimeout(800);
const after = await page.evaluate(() => ({
  streamOnScreen: [...document.querySelectorAll("video")].some((v) => v.src.startsWith("blob:") && getComputedStyle(v).opacity === "1" && v.style.zIndex === "3"),
}));
await browser.close();

// Brightness shown against loudness played: at which delay do they agree best?
const t = samples.map((s) => s[0]);
const loud = samples.map((s) => Math.min(1, s[1] / 0.12));
const bright = samples.map((s) => Math.max(0, (s[2] - 16) / 219));
const at = (series, time) => {
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= time) lo = mid; else hi = mid; }
  return series[lo];
};
let best = null;
const voiced = t.filter((_, i) => loud[i] > 0.05 || bright[i] > 0.05);
for (let lag = -400; lag <= 400; lag += 10) {
  let sum = 0, a2 = 0, b2 = 0;
  for (const time of voiced) {
    const a = at(loud, time), b = at(bright, time + lag);
    sum += a * b; a2 += a * a; b2 += b * b;
  }
  const match = sum / Math.sqrt(a2 * b2 || 1);
  if (!best || match > best.match) best = { pictureAfterSoundMs: lag, match: Math.round(match * 1000) / 1000 };
}
const speaking = samples.filter((s) => s[1] > 0.012);
// Stretches in which the filmed clip showed instead of the stream, once the stream had begun.
const gaps = [];
let since = null, begun = false;
for (const s of samples) {
  if (s[3] > 0.5) { begun = true; if (since !== null) { gaps.push(Math.round((s[0] - since) / 10) / 100); since = null; } }
  else if (begun && since === null) since = s[0];
}
if (since !== null) gaps.push(Math.round((samples[samples.length - 1][0] - since) / 10) / 100);
const result = {
  started, seconds, samples: samples.length,
  pictureAgainstSound: best,
  streamOnScreenShare: samples.length ? Math.round(samples.filter((s) => s[3] > 0.5).length / samples.length * 1000) / 1000 : null,
  streamOnScreenWhileSheSpeaks: speaking.length ? Math.round(speaking.filter((s) => s[3] > 0.5).length / speaking.length * 1000) / 1000 : null,
  filmedClipShowedInsteadSeconds: gaps,
  voiceDelaySeconds: samples.length ? samples[samples.length - 1][5] : null,
  describe, afterHangUp: after, errors,
};
fs.writeFileSync(path.join(out, "samples.json"), JSON.stringify(samples));
fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify(result, null, 1));
