"use client";
import React, { useEffect, useRef, useState } from "react";
import { DEFAULT_SCRIPT } from "../lib/library";
import { MAX_INPUT_LENGTH } from "@/lib/limits";
import { kindOf, readTextFile, transcribeFile } from "@/lib/files";
import { readImage, readPdf, readWord } from "@/lib/documents";
import { Block } from "./ui/Block";
import { Footer } from "./ui/Footer";
import { Header } from "./ui/Header";
import { useBodyScrollable } from "@/hooks/useBodyScrollable";
import { appStore } from "@/lib/store";
import { toUrduScript } from "@/lib/script";
import { needsUrduStep } from "@/lib/spoken";
import { EngineStatus, refreshEngineStatus } from "./EngineStatus";
import { LiveCall } from "./LiveCall";
import { useLiveTranscribe } from "@/hooks/useLiveTranscribe";

export default function TtsPage() {
  const isScrollable = useBodyScrollable();

  return (
    <div
      data-scrollable={isScrollable}
      className="flex flex-col gap-x-3 min-h-screen px-5 pt-6 pb-32 md:pb-24 selection:bg-primary/20"
    >
      <Header />
      <Board />
      <Footer />
    </div>
  );
}

// The page itself is only what is used every time: the script, and the
// call. The voice, the vibe and the options live in the Settings menu.
const Board = () => {
  const input = appStore.useState((state) => state.input);
  const inputDirty = appStore.useState((state) => state.inputDirty);
  const urduMode = appStore.useState((state) => state.urduMode);
  const styledText = appStore.useState((state) => state.styledText);
  const showEngines = appStore.useState((state) => state.showEngines);
  const [converting, setConverting] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Earlier versions used a service worker; remove it where it is still
  // installed, so it cannot serve stale files.
  useEffect(() => {
    navigator.serviceWorker
      ?.getRegistrations()
      .then((list) => list.forEach((worker) => worker.unregister()))
      .catch(() => {});
  }, []);

  // Input file: a text file becomes the script as it is; a voice file is
  // transcribed first.
  const handleFile = async (file: File | undefined) => {
    if (!file || reading) return;
    const kind = kindOf(file);
    if (kind === "other") {
      alert(
        "Use a text, Word or PDF file, a photo of a page, or a voice recording."
      );
      return;
    }

    setReading(true);
    try {
      let text: string;
      let truncated = false;
      if (kind === "text") {
        text = await readTextFile(file);
      } else if (kind === "word") {
        ({ text, truncated } = await readWord(file));
      } else if (kind === "pdf") {
        ({ text, truncated } = await readPdf(file));
      } else if (kind === "image") {
        ({ text, truncated } = await readImage(file));
      } else {
        ({ text, truncated } = await transcribeFile(file));
      }
      if (!text.trim()) {
        alert("That file has no text in it.");
        return;
      }
      if (text.length > MAX_INPUT_LENGTH - 1) {
        truncated = true;
        text = text.slice(0, MAX_INPUT_LENGTH - 1);
      }
      appStore.setState((draft) => {
        draft.input = text;
        draft.inputDirty = true;
        draft.styledText = null;
        draft.latestAudio = null;
      });
      if (truncated) {
        alert(
          `The file is longer than this app takes in one go. Only the first part was loaded (up to ${
            MAX_INPUT_LENGTH - 1
          } characters).`
        );
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not read that file.");
    } finally {
      setReading(false);
      refreshEngineStatus();
    }
  };

  // Live dictation: what is heard is added after the text that was in the
  // script box when the microphone was switched on.
  const dictationBase = useRef("");
  const mic = useLiveTranscribe({
    onTranscript: (heard) => {
      appStore.setState((draft) => {
        const base = dictationBase.current;
        draft.input = [base, heard]
          .filter(Boolean)
          .join(" ")
          .slice(0, MAX_INPUT_LENGTH - 1);
        draft.inputDirty = true;
        draft.latestAudio = null;
      });
    },
    onError: (message) => alert(message),
  });

  // Show which engine took the microphone, and any failover afterwards.
  useEffect(() => {
    refreshEngineStatus();
  }, [mic.status]);

  const handleMicToggle = () => {
    if (mic.status === "idle") {
      // Replace the untouched sample script, but keep text the user wrote.
      dictationBase.current = inputDirty ? input.trim() : "";
      mic.start();
    } else if (mic.status === "listening" || mic.status === "starting") {
      mic.stop();
    }
  };

  // Replaces the script with the Urdu text that will actually be spoken,
  // so it can be read and corrected before Play.
  const handleShowUrdu = async () => {
    if (converting) return;
    setConverting(true);
    const original = appStore.getState().input;
    const { text, ok } = await toUrduScript(original, true);
    setConverting(false);
    refreshEngineStatus();

    if (!ok) {
      alert("Could not convert the script to Urdu.");
      return;
    }

    appStore.setState((draft) => {
      // Leave the box alone if the script was edited while converting.
      if (draft.input !== original) return;
      draft.input = text;
      draft.styledText = text;
      draft.inputDirty = true;
      draft.latestAudio = null;
    });
  };

  return (
    <main className="flex-1 flex flex-col gap-x-3 w-full max-w-(--page-max-width) mx-auto">
      <Block title="Script">
        <div className="relative flex flex-col h-full w-full">
          <textarea
            id="prompt"
            dir="auto"
            rows={9}
            maxLength={MAX_INPUT_LENGTH - 1}
            className="w-full h-full min-h-[240px] resize-none outline-none focus:outline-none bg-screen p-4 pb-10 rounded-lg shadow-textarea text-[16px]"
            value={input}
            onChange={({ target }) => {
              const nextValue = target.value;

              appStore.setState((draft) => {
                draft.inputDirty = !!nextValue && nextValue !== DEFAULT_SCRIPT;
                draft.input = nextValue;
                draft.latestAudio = null;
              });
            }}
          />
          {inputDirty && (
            <span
              className="absolute bottom-[-27px] sm:bottom-3 left-4 z-10 cursor-pointer uppercase hover:text-current/70 transition-colors"
              onClick={() => {
                appStore.setState((draft) => {
                  draft.inputDirty = false;
                  draft.input = DEFAULT_SCRIPT;
                  draft.latestAudio = null;
                });
              }}
            >
              Reset
            </span>
          )}
          <span className="absolute bottom-[-27px] sm:bottom-3 right-4 sm:right-16 z-10 flex gap-4 uppercase">
            {needsUrduStep({ urduMode, input, styledText }) && (
              <span
                className="cursor-pointer hover:text-current/70 transition-colors"
                onClick={handleShowUrdu}
              >
                {converting ? "Converting…" : "Show Urdu"}
              </span>
            )}
            <span
              className="cursor-pointer hover:text-current/70 transition-colors"
              title="Load a text, Word or PDF file, a photo of a page, or a voice recording"
              onClick={() => fileInput.current?.click()}
            >
              {reading ? "Reading…" : "Upload"}
            </span>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".txt,.md,.srt,.vtt,text/plain,.docx,.doc,.pdf,application/pdf,image/*,audio/*,video/mp4,video/webm,.mp3,.wav,.m4a,.ogg,.opus,.flac,.aac,.amr"
              onChange={({ target }) => {
                handleFile(target.files?.[0]);
                target.value = "";
              }}
            />
            <span
              className={`cursor-pointer hover:text-current/70 transition-colors ${
                mic.status === "listening" ? "text-primary" : ""
              }`}
              title="Dictate the script with live transcription"
              onClick={handleMicToggle}
            >
              {mic.status === "idle"
                ? "Mic"
                : mic.status === "starting"
                ? "Starting…"
                : mic.status === "listening"
                ? "● Stop"
                : "Finishing…"}
            </span>
          </span>
          <span className="absolute bottom-3 right-4 z-10 opacity-30 hidden sm:block">
            {input.length}
          </span>
        </div>
      </Block>
      <LiveCall />
      {showEngines && <EngineStatus />}
    </main>
  );
};
