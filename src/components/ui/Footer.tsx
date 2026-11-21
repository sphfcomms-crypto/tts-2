import React from "react";
import s from "./Footer.module.css";
import PlayButton from "../PlayButton";
import { SaveButtons } from "../DownloadButton";

// Output: save the voice file, save the text file, or just listen.
export const Footer = () => {
  return (
    <footer className={`${s.Footer} py-3 px-6`}>
      <div className="relative w-full max-w-(--page-max-width) m-auto">
        <div className="grid grid-cols-4 gap-3">
          <SaveButtons />
          <div className="flex col-span-2">
            <PlayButton />
          </div>
        </div>
      </div>
    </footer>
  );
};
