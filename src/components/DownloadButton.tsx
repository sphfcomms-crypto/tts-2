import React, { useState } from "react";
import { Download } from "./ui/Icons";
import { Button } from "./ui/Button";
import { appStore } from "@/lib/store";
import { spokenText } from "@/lib/spoken";
import {
  fetchSpeech,
  saveFile,
  speechRequest,
  textBlob,
} from "@/lib/files";
import { refreshEngineStatus } from "./EngineStatus";

// The two output files: the voice (the same clip Play makes) and the text
// (the words the voice says, after the Urdu fix).
export function SaveButtons() {
  const [busy, setBusy] = useState<"voice" | "text" | null>(null);

  const saveVoice = async () => {
    if (busy) return;
    setBusy("voice");
    try {
      const { init, filename } = await speechRequest();
      // Play may already have made this clip; if not, make it now.
      let clip = appStore.getState().latestAudio;
      if (!clip) {
        clip = await fetchSpeech(init);
        appStore.setState({ latestAudio: clip });
      }
      saveFile(clip, filename.replace(/\.(wav|mp3)$/, clip.type === "audio/wav" ? ".wav" : ".mp3"));
    } catch (err) {
      console.error("Could not save the voice file:", err);
      alert("Could not make the voice file.");
    } finally {
      setBusy(null);
      refreshEngineStatus();
    }
  };

  const saveText = async () => {
    if (busy) return;
    setBusy("text");
    try {
      const text = await spokenText();
      if (!text.trim()) return;
      saveFile(textBlob(text), "tts-text.txt");
    } catch (err) {
      console.error("Could not save the text file:", err);
      alert("Could not make the text file.");
    } finally {
      setBusy(null);
      refreshEngineStatus();
    }
  };

  return (
    <>
      <Button color="tertiary" onClick={saveVoice} disabled={busy !== null}>
        <Download />
        <span className="uppercase pr-3">
          {busy === "voice" ? "Making…" : "Voice"}
        </span>
      </Button>
      <Button color="tertiary" onClick={saveText} disabled={busy !== null}>
        <Download />
        <span className="uppercase pr-3">
          {busy === "text" ? "Making…" : "Text"}
        </span>
      </Button>
    </>
  );
}
