import test from "node:test";
import assert from "node:assert/strict";
import { avatarBus, type Stage } from "../src/lib/avatar/bus";
import { rendererFor } from "../src/lib/avatarGpu";

test("an early call waits for the film stage; cancellation and an offline renderer release it", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  try {
    avatarBus.setVideoAvailable(true);
    const controller = new AbortController();
    let connected = false;
    const ready = avatarBus.waitForStage(controller.signal).then(() => { connected = true; });
    await Promise.resolve();
    assert.equal(connected, false);
    avatarBus.setStage({} as Stage);
    await ready;
    assert.equal(connected, true);
    avatarBus.setStage(null);
    const cancel = avatarBus.waitForStage(controller.signal);
    controller.abort();
    await cancel;
    const offline = avatarBus.waitForStage(new AbortController().signal);
    avatarBus.setVideoAvailable(false);
    await offline;
  } finally {
    avatarBus.setStage(null);
    avatarBus.setVideoAvailable(undefined);
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("an asleep rental routes supported film frames to the local performer", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.AVATAR_GPU_URL;
  const originalKey = process.env.AVATAR_GPU_KEY;
  process.env.AVATAR_GPU_URL = "http://127.0.0.1:31999";
  process.env.AVATAR_GPU_KEY = "video-test";
  globalThis.fetch = async (input, options) => {
    assert.equal(new Headers(options?.headers).get("x-avatar-key"), "video-test");
    if (String(input) === process.env.AVATAR_GPU_URL + "/health") throw Error("rental asleep");
    assert.equal(String(input), "http://127.0.0.1:8191/health");
    return Response.json({ ok: true, clips: [{ name: "oa1_talk_explain", frames: 134 }] });
  };
  try {
    assert.equal((await rendererFor("oa1_talk_explain"))?.kind, "cpu");
    assert.equal(await rendererFor("missing-clip"), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.AVATAR_GPU_URL;
    else process.env.AVATAR_GPU_URL = originalUrl;
    if (originalKey === undefined) delete process.env.AVATAR_GPU_KEY;
    else process.env.AVATAR_GPU_KEY = originalKey;
  }
});
