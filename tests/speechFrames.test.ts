import assert from "node:assert/strict";
import { test } from "node:test";
import { frameHeader, SpeechFrameReader } from "../src/lib/speechFrames";

const text = "آپ please بولیں۔";
const utf8 = new TextEncoder().encode(text);
const pcm = new Uint8Array([1, 0, 2, 0]);
const phrase = Buffer.concat([frameHeader(utf8.length, pcm.length, 5520), utf8, pcm]);
const end = frameHeader(0, 0, 0);

function readFrames(bytes: Uint8Array, chunkSize: number) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize) {
        controller.enqueue(bytes.subarray(at, at + chunkSize));
      }
      controller.close();
    },
  });
  return new SpeechFrameReader(body.getReader());
}

test("split and coalesced frames preserve phrase, PCM, and trailing pause", async () => {
  for (const chunkSize of [1, 7, 4096]) {
    const reader = readFrames(Buffer.concat([phrase, phrase, end]), chunkSize);
    const expected = { text, pcm, gapSamples: 5520 };
    assert.deepEqual(await reader.next(), expected);
    assert.deepEqual(await reader.next(), expected);
    assert.equal(await reader.next(), null);
  }
});

test("disconnecting at a frame boundary cannot complete a partial recording", async () => {
  const reader = readFrames(phrase, 16);
  assert.ok(await reader.next());
  await assert.rejects(reader.next(), /ended early/);
  const partial = readFrames(phrase.subarray(0, phrase.length - 1), 7);
  await assert.rejects(partial.next(), /ended early/);
});
