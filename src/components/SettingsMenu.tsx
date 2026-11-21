import React from "react";
import { Dialog, Switch } from "radix-ui";
import { CALL_ONLY_VOICES, VIBES, VOICES } from "@/lib/library";
import { appStore, Toggles } from "@/lib/store";
import { Button, ButtonLED } from "./ui/Button";

const TOGGLES: { key: keyof Toggles; label: string; note: string }[] = [
  {
    key: "urduMode",
    label: "Urdu fix",
    note: "Rewrites the script in Urdu script, in her words, with grammar and punctuation fixed. Off: it is read exactly as written.",
  },
  {
    key: "greetFirst",
    label: "She says hello first",
    note: "On a call she greets you as soon as it connects. Off: she waits for you to speak.",
  },
  {
    key: "captions",
    label: "Call captions",
    note: "Shows what each of you says during a call.",
  },
  {
    key: "sounds",
    label: "Button sounds",
    note: "The click when a button is pressed.",
  },
  {
    key: "showEngines",
    label: "Show engines",
    note: "A line at the bottom of the page naming the model used for each job.",
  },
];

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="mb-8">
    <div className="flex items-center gap-2 mb-3">
      <span className="uppercase text-current/70">{title}</span>
      <span className="flex-1 h-[1px] bg-foreground/8" />
    </div>
    {children}
  </section>
);

// Everything that is chosen once and then left alone: the voice, the
// speaking style, and the on/off options. Opened from the header.
export function SettingsMenu() {
  const state = appStore.useState();

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="uppercase cursor-pointer hover:text-current/70 transition-colors"
        >
          Settings
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 z-100" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed z-100 top-0 right-0 h-full w-full max-w-[460px] overflow-y-auto bg-background p-5 shadow-[-8px_0_24px_rgba(0,0,0,0.15)] focus:outline-none"
        >
          <div className="flex items-baseline justify-between mb-8">
            <Dialog.Title className="text-[18px] font-bold">
              Settings
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="uppercase cursor-pointer hover:text-current/70 transition-colors"
              >
                Close
              </button>
            </Dialog.Close>
          </div>

          <Section title="Voice">
            <div className="grid grid-cols-2 gap-3">
              {VOICES.map((name) => (
                <Button
                  key={name}
                  block
                  color="default"
                  onClick={() => {
                    appStore.setState((draft) => {
                      draft.voice = name;
                      draft.latestAudio = null;
                    });
                  }}
                  selected={name === state.voice}
                  className="min-h-[56px] flex-col items-start justify-between relative"
                >
                  <span>
                    {name[0].toUpperCase()}
                    {name.substring(1)}
                  </span>
                  <div className="absolute left-[0.93rem] bottom-[0.93rem]">
                    <ButtonLED />
                  </div>
                  {CALL_ONLY_VOICES.includes(name) && (
                    <div className="absolute right-[13px] bottom-[9px] text-[10px] uppercase opacity-60">
                      call only
                    </div>
                  )}
                </Button>
              ))}
            </div>
          </Section>

          <Section title="Vibe">
            <div className="grid grid-cols-2 gap-3 mb-3">
              {VIBES.map((entry) => (
                <Button
                  key={entry.name}
                  block
                  color="default"
                  onClick={() => {
                    // A vibe changes how it is said, never what is said.
                    appStore.setState((draft) => {
                      draft.prompt = entry.prompt;
                      draft.vibe = entry.name;
                      draft.latestAudio = null;
                    });
                  }}
                  selected={state.vibe === entry.name}
                  className="min-h-[56px] flex-col items-start justify-between relative"
                >
                  <span className="break-words pr-1">{entry.name}</span>
                  <div className="absolute left-[0.93rem] bottom-[0.93rem]">
                    <ButtonLED />
                  </div>
                </Button>
              ))}
            </div>
            <label className="block text-current/70 mb-2" htmlFor="vibe-notes">
              Voice instructions (edit to make your own vibe)
            </label>
            <textarea
              id="vibe-notes"
              rows={7}
              maxLength={999}
              className="w-full resize-none outline-none focus:outline-none bg-screen p-4 rounded-lg shadow-textarea text-[16px] md:text-[14px]"
              value={state.prompt}
              onChange={({ target }) => {
                appStore.setState((draft) => {
                  draft.vibe = null;
                  draft.prompt = target.value;
                  draft.latestAudio = null;
                });
              }}
            />
          </Section>

          <Section title="Options">
            <div className="flex flex-col gap-5">
              {TOGGLES.map(({ key, label, note }) => (
                <label
                  key={key}
                  className="flex items-start justify-between gap-4 cursor-pointer"
                >
                  <span>
                    <span className="block">{label}</span>
                    <span className="block text-current/60 mt-1">{note}</span>
                  </span>
                  <Switch.Root
                    checked={state[key]}
                    onCheckedChange={(on) => {
                      appStore.setState((draft) => {
                        draft[key] = on;
                        if (key === "urduMode") draft.latestAudio = null;
                      });
                    }}
                    className="relative shrink-0 flex items-center w-[44px] h-[24px] rounded-full bg-black/20 data-[state=checked]:bg-primary transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <Switch.Thumb className="block w-[20px] h-[20px] rounded-full bg-white shadow translate-x-[2px] data-[state=checked]:translate-x-[22px] transition-transform" />
                  </Switch.Root>
                </label>
              ))}
            </div>
          </Section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
