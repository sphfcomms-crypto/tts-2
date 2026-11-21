import { appStore } from "@/lib/store";
import { SettingsMenu } from "../SettingsMenu";

const title = (name: string) => name[0].toUpperCase() + name.substring(1);

export const Header = () => {
  const voice = appStore.useState((state) => state.voice);
  const vibe = appStore.useState((state) => state.vibe);

  return (
    <header className="flex w-full max-w-(--page-max-width) mx-auto mb-8 items-baseline gap-x-4">
      <span className="text-[22px] leading-[18px] font-bold tracking-tight">
        TTS
      </span>
      <span className="text-current/70 hidden sm:inline">
        Urdu voice and live call
      </span>
      <span className="flex-1" />
      {/* What is selected in Settings, so it is visible without opening it. */}
      <span className="text-current/70">
        {title(voice)} · {vibe ?? "Custom vibe"}
      </span>
      <SettingsMenu />
    </header>
  );
};
