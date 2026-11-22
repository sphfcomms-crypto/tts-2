import { appStore } from "./store";
import { spokenText } from "./spoken";
import { finishWav } from "./streamPlayer";

// File in, file out: reading an uploaded text or voice file into the
// script, and building the voice and text files to save.

// Chrome, Edge and other Blink browsers are sent streamed WAV; the rest MP3.
export const IS_BLINK =
  /Chrom(e|ium)\//.test(navigator.userAgent) &&
  !/iPad|iPhone|iPod/.test(navigator.userAgent);

const TEXT_NAME = /\.(txt|text|md|markdown|srt|vtt|csv|log)$/i;
const IMAGE_NAME = /\.(jpe?g|png|webp|bmp|gif)$/i;
const AUDIO_NAME =
  /\.(mp3|wav|m4a|mp4|mpeg|mpga|ogg|oga|opus|webm|flac|aac|amr|3gp)$/i;

export type FileKind = "text" | "voice" | "word" | "pdf" | "image" | "other";

export function kindOf(file: File): FileKind {
  if (/\.docx?$/i.test(file.name)) return "word";
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (file.type.startsWith("image/") || IMAGE_NAME.test(file.name)) {
    return "image";
  }
  if (file.type.startsWith("audio/") || file.type.startsWith("video/")) {
    return "voice";
  }
  if (AUDIO_NAME.test(file.name)) return "voice";
  if (file.type.startsWith("text/") || TEXT_NAME.test(file.name)) return "text";
  return "other";
}

// Reads a text file whatever Windows saved it as: UTF-8, or the UTF-16
// that Notepad calls "Unicode".
export async function readTextFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";

  let text = new TextDecoder(encoding).decode(bytes);
  // Subtitle files: keep the words, drop the numbering and the timings.
  if (/\.(srt|vtt)$/i.test(file.name)) {
    text = text
      .split(/\r?\n/)
      .filter(
        (line) =>
          !/^\s*\d+\s*$/.test(line) &&
          !/-->/.test(line) &&
          !/^WEBVTT/.test(line)
      )
      .join("\n");
  }
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Sends a voice recording to be transcribed.
export async function transcribeFile(
  file: File
): Promise<{ text: string; truncated: boolean }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/transcribe-file", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error((await res.text()) || "Could not read that recording.");
  }
  return res.json();
}

// The request that makes the voice for the current script and settings.
export async function speechRequest(): Promise<{
  init: RequestInit;
  filename: string;
}> {
  const { prompt, voice, vibe } = appStore.getState();
  const style = vibe?.toLowerCase().replace(/ /g, "-") ?? "custom";
  const form = new FormData();
  form.append("input", await spokenText());
  form.append("prompt", prompt);
  form.append("voice", voice);
  form.append("vibe", style);
  return {
    init: { method: "POST", body: form },
    filename: `tts-${voice}-${style}.${IS_BLINK ? "wav" : "mp3"}`,
  };
}

// A clip made with the download button can be played later. Remember the
// actual (possibly rewritten) script used to generate that exact Blob.
const clipScripts = new WeakMap<Blob, string>();
export const clipScript = (clip: Blob) => clipScripts.get(clip);

// Fetches the whole clip (no playback) as a file ready to save or play.
export async function fetchSpeech(init: RequestInit): Promise<Blob> {
  const res = await fetch("/api/generate", init);
  if (!res.ok) {
    throw new Error((await res.text()) || "Could not make the audio.");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const wav = (res.headers.get("content-type") || "").includes("wav");
  const clip = new Blob([new Uint8Array(wav ? finishWav(bytes) : bytes)], {
    type: wav ? "audio/wav" : "audio/mpeg",
  });
  const input = init.body instanceof FormData ? init.body.get("input") : null;
  if (typeof input === "string") clipScripts.set(clip, input);
  return clip;
}

export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// A text file that opens with the right letters everywhere: UTF-8 with the
// mark that tells Windows programs so.
export const textBlob = (text: string) =>
  new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" });
