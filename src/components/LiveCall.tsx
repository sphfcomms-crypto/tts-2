import React, { useState } from "react";
import { Block } from "./ui/Block";
import { Button } from "./ui/Button";
import { appStore } from "@/lib/store";
import { useLiveCall } from "@/hooks/useLiveCall";
import { refreshEngineStatus } from "./EngineStatus";

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

// Keeps the end of a long caption, so the newest words stay in view.
const tail = (text: string, length = 220) =>
  text.length > length ? "…" + text.slice(-length) : text;

// The live call: talk with her in real time, in the selected voice and vibe.
export function LiveCall() {
  const [captions, setCaptions] = useState({ you: "", her: "" });
  const showCaptions = appStore.useState((state) => state.captions);

  const call = useLiveCall({
    onCaption: (who, text) =>
      setCaptions((current) => ({ ...current, [who]: text })),
    onError: (message) => alert(message),
  });

  const toggle = () => {
    if (call.status === "idle") {
      const { voice, prompt, greetFirst } = appStore.getState();
      setCaptions({ you: "", her: "" });
      call.start(voice, prompt, greetFirst).finally(refreshEngineStatus);
    } else {
      call.stop();
    }
  };

  const live = call.status === "live";

  return (
    <Block title="Live call">
      <div className="flex flex-col md:flex-row gap-3">
        <div className="md:w-[220px] shrink-0">
          <Button
            block
            color={call.status === "idle" ? "tertiary" : "primary"}
            onClick={toggle}
            selected={call.status !== "idle"}
            className="min-h-[60px]"
          >
            <span className="uppercase">
              {call.status === "idle"
                ? "Call her"
                : call.status === "connecting"
                ? "Connecting…"
                : `End call ${clock(call.seconds)}`}
            </span>
          </Button>
        </div>
        <div
          dir="auto"
          className="flex-1 min-h-[60px] bg-screen p-4 rounded-lg shadow-textarea text-[16px] md:text-[14px]"
        >
          {!showCaptions || (call.status === "idle" && !captions.her && !captions.you) ? (
            <span className="opacity-50">
              {call.status === "idle"
                ? "Talk with her live, in the voice and vibe chosen in Settings. Your microphone is used only while the call is on."
                : live
                ? "On the call. Just talk."
                : "Connecting…"}
            </span>
          ) : (
            <>
              <div>
                <span className="uppercase opacity-50">Her </span>
                {tail(captions.her) || (live ? "…" : "")}
              </div>
              <div className="mt-2">
                <span className="uppercase opacity-50">You </span>
                {tail(captions.you)}
              </div>
            </>
          )}
        </div>
      </div>
    </Block>
  );
}
