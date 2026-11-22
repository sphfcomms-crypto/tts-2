import assert from "node:assert/strict";
import { test } from "node:test";
import { frameHeader, PIECE_MEDIA_TYPE } from "../src/lib/speechFrames";
import { StreamPlayer } from "../src/lib/streamPlayer";

test("script download starts immediately and cancellation during calibration stays silent", async (t) => {
  const wav = new Uint8Array(44);
  new DataView(wav.buffer).setUint32(24, 24000, true);
  const speech = Buffer.concat([wav, frameHeader(1, 4, 0), Buffer.from("a"), Buffer.alloc(4), frameHeader(0, 0, 0)]);
  let downloads = 0, scheduled = 0;
  t.mock.method(globalThis, "fetch", async () => {
    downloads++;
    return new Response(speech, { headers: { "Content-Type": PIECE_MEDIA_TYPE } });
  });
  const context = {
    currentTime: 1,
    createAnalyser: () => ({ disconnect() {} }),
    createBuffer: () => ({ getChannelData: () => new Float32Array(2), duration: 2 / 24000 }),
    createBufferSource: () => ({ connect() {}, start() { scheduled++; }, stop() {} }),
  } as unknown as AudioContext;

  for (const cancel of [true, false]) {
    const player = new StreamPlayer(context, null);
    let ready!: () => void;
    const before = downloads;
    const pending = player.start("/generate", {}, new Promise<void>((resolve) => { ready = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(downloads, before + 1);
    assert.equal(scheduled, 0);
    if (cancel) player.stop();
    ready();
    await pending;
  }
  assert.equal(scheduled, 1);
});
