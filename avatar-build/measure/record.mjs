// Records what the live site really shows and plays, at real speed.
//
//   node record.mjs <out dir> <idle|play|call> [seconds] [mic wav for a call]
//
// A real Chrome is driven without a window. Saved in <out dir>:
//   frames/NNNNNN.jpg + frames.json   every picture the page drew, with the time it was drawn
//   audio-K.wav + audio.json          everything the page sent to the loudspeaker, with the time
//                                     each sample is heard
//   log.json                          sixty times a second: what each video element was doing
// All times are on one clock (milliseconds since 1970), so sound and picture can be compared.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const [, , outDir, scenario = "idle", secondsArg = "30", micWav = ""] = process.argv;
if (!outDir) throw new Error("usage: node record.mjs <out dir> <idle|play|call> [seconds] [mic wav]");
const SECONDS = Number(secondsArg);
const SITE = process.env.SITE || "https://cua-hub.tail372a9e.ts.net/";
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });

// Runs in the page before any of its own code.
const INSTRUMENT = () => {
  const rec = (window.__rec = { ctxs: [], log: [], events: [] });
  const origConnect = AudioNode.prototype.connect;
  const WORKLET = `
    class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(128 * 32); this.n = 0; this.start = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (this.n === 0) this.start = currentFrame;
        if (ch) this.buf.set(ch, this.n); else this.buf.fill(0, this.n, this.n + 128);
        this.n += 128;
        if (this.n >= this.buf.length) {
          this.port.postMessage({ start: this.start, data: this.buf.slice(0, this.n) });
          this.n = 0;
        }
        return true;
      }
    }
    registerProcessor("rec-tap", Tap);`;

  function tapFor(ctx) {
    let entry = rec.ctxs.find((e) => e.ctx === ctx);
    if (entry) return entry;
    entry = { ctx, rate: ctx.sampleRate, chunks: [], clock: [], node: null, pending: [], made: performance.now() };
    rec.ctxs.push(entry);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    ctx.audioWorklet.addModule(url).then(() => {
      const node = new AudioWorkletNode(ctx, "rec-tap", {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit",
      });
      node.port.onmessage = (e) => entry.chunks.push(e.data);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      origConnect.call(node, mute);
      origConnect.call(mute, ctx.destination);
      entry.node = node;
      for (const source of entry.pending) origConnect.call(source, node);
      entry.pending = [];
    }).catch((err) => rec.events.push([performance.now(), "worklet failed: " + err]));
    setInterval(() => {
      try {
        const o = ctx.getOutputTimestamp();
        entry.clock.push([o.contextTime, o.performanceTime, ctx.currentTime, performance.now(),
          ctx.outputLatency || 0, ctx.baseLatency || 0]);
      } catch {}
    }, 200);
    return entry;
  }

  // Whatever is connected to a loudspeaker is also connected to the recorder.
  AudioNode.prototype.connect = function (dest, ...rest) {
    const out = origConnect.call(this, dest, ...rest);
    try {
      if (dest && dest === this.context.destination) {
        const entry = tapFor(this.context);
        if (entry.node) origConnect.call(this, entry.node);
        else entry.pending.push(this);
      }
    } catch {}
    return out;
  };

  const tick = () => {
    const videos = [...document.querySelectorAll("video")].map((v) => {
      const src = v.currentSrc || "";
      const style = getComputedStyle(v);
      return [
        v.dataset.unit || (src.startsWith("blob:") ? "lips" : src.split("/").pop().replace(".mp4", "")),
        +v.currentTime.toFixed(3), v.paused ? 1 : 0, +style.opacity, +style.zIndex || 0, v.readyState,
      ];
    });
    rec.log.push([performance.now(), videos]);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  rec.dump = () => {
    const b64 = (f32) => {
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
      const bytes = new Uint8Array(i16.buffer);
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return {
      origin: performance.timeOrigin,
      talk: window.__talk && window.__talk.timeline ? window.__talk.timeline() : null,
      now: [performance.now(), rec.ctxs.map((e) => e.ctx.currentTime)],
      log: rec.log,
      events: rec.events,
      ctxs: rec.ctxs.map((e) => ({
        rate: e.rate, made: e.made, clock: e.clock, state: e.ctx.state,
        chunks: e.chunks.map((c) => ({ start: c.start, b64: b64(c.data) })),
      })),
    };
  };
};

function wav(samples, rate) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + samples.length * 2, 4); head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([head, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]);
}

const args = [
  "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--window-size=900,760",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
];
if (micWav) args.push(`--use-file-for-fake-audio-capture=${path.resolve(micWav)}%noloop`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args, protocolTimeout: 45000,
  defaultViewport: { width: 880, height: 700, deviceScaleFactor: 1 },
});
const notes = [];
try {
  const page = await browser.newPage();
  await page.setBypassCSP(true); // only so the recorder's own audio tap may load
  await page.evaluateOnNewDocument(INSTRUMENT);
  page.on("console", (m) => { if (m.type() === "error") notes.push(["console", m.text().slice(0, 300)]); });
  page.on("pageerror", (e) => notes.push(["pageerror", String(e).slice(0, 300)]));
  page.on("requestfailed", (r) => notes.push(["requestfailed", r.url().replace(/[a-z0-9-]+\.trycloudflare/, "<tunnel>.trycloudflare").slice(0, 120), r.failure()?.errorText]));

  const cdp = await page.createCDPSession();
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const name = String(n++).padStart(6, "0") + ".jpg";
    fs.writeFile(path.join(outDir, "frames", name), Buffer.from(f.data, "base64"), () => {});
    frames.push([name, f.metadata.timestamp * 1000]);
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });

  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused),
    { timeout: 60000 }
  ).catch(() => notes.push(["note", "no playing video appeared within 60 s"]));
  await new Promise((r) => setTimeout(r, 2500));
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  const started = Date.now();
  const marks = [["recording", started]];

  const clickText = async (pattern) => {
    const clicked = await page.evaluate((source) => {
      const re = new RegExp(source, "i");
      const all = [...document.querySelectorAll("button, [role=button]")];
      const hit = all.find((el) => re.test((el.innerText || el.getAttribute("aria-label") || "").trim()));
      if (!hit) return all.map((el) => (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30));
      hit.click();
      return true;
    }, pattern);
    marks.push([clicked === true ? `clicked ${pattern}` : `NOT FOUND ${pattern}: ${JSON.stringify(clicked)}`, Date.now()]);
    return clicked === true;
  };

  await new Promise((r) => setTimeout(r, 3000));
  if (scenario === "play") await clickText("^play$");
  if (scenario === "call") await clickText("call");
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  if (scenario === "call") await clickText("end|hang|stop");
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.send("Page.stopScreencast");
  marks.push(["stopped", Date.now()]);

  const data = await page.evaluate(() => window.__rec.dump());
  const audio = [];
  data.ctxs.forEach((ctx, k) => {
    if (!ctx.chunks.length) { audio.push({ file: null, rate: ctx.rate, made: ctx.made, clock: ctx.clock, state: ctx.state }); return; }
    const first = ctx.chunks[0].start;
    const last = ctx.chunks[ctx.chunks.length - 1];
    const lastLength = Buffer.from(last.b64, "base64").length / 2;
    const all = new Int16Array(last.start - first + lastLength);
    for (const chunk of ctx.chunks) {
      const bytes = Buffer.from(chunk.b64, "base64");
      all.set(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2), chunk.start - first);
    }
    const file = `audio-${k}.wav`;
    fs.writeFileSync(path.join(outDir, file), wav(all, ctx.rate));
    audio.push({ file, rate: ctx.rate, firstFrame: first, made: ctx.made, clock: ctx.clock, state: ctx.state });
  });
  fs.writeFileSync(path.join(outDir, "audio.json"), JSON.stringify({ origin: data.origin, audio }));
  fs.writeFileSync(path.join(outDir, "frames.json"), JSON.stringify(frames));
  fs.writeFileSync(path.join(outDir, "log.json"), JSON.stringify({ origin: data.origin, log: data.log, events: data.events, talk: data.talk }));
  fs.writeFileSync(path.join(outDir, "marks.json"), JSON.stringify({ scenario, marks, notes }));
  const seconds = (marks[marks.length - 1][1] - started) / 1000;
  console.log(JSON.stringify({
    scenario, frames: frames.length, seconds: +seconds.toFixed(1), framesPerSecond: +(frames.length / seconds).toFixed(1),
    audio: audio.map((a) => ({ file: a.file, rate: a.rate, clock: a.clock.length, state: a.state })),
    logRows: data.log.length, marks: marks.map((m) => m[0]), notes: notes.slice(0, 8),
  }, null, 1));
} finally {
  await browser.close();
}
