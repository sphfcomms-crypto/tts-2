import { MAX_INPUT_LENGTH } from "./limits";

// Reading documents into the script: Word files, PDFs and photos of pages.
//
// A PDF is opened here in the browser. A page whose stored text is plain
// Latin (English and the like) is taken as it is. A page with Urdu or
// Arabic, or with no stored text at all (a scan), is turned into a picture
// and read by a vision model on the server, because the text stored in an
// Urdu PDF has the letters of every word in a scrambled order.

// gaps: some words could not be read off the page and are marked […].
type Result = { text: string; truncated: boolean; gaps?: boolean };

const MAX_PAGES = 8; // the server takes this many pictures per request
const PAGE_WIDTH = 1400; // pixels: wide enough for small Nastaliq to be read
const MAX_SCALE = 3;
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

const limit = (text: string): Result => ({
  text: text.slice(0, MAX_INPUT_LENGTH - 1),
  truncated: text.length > MAX_INPUT_LENGTH - 1,
});

async function post(form: FormData) {
  const res = await fetch("/api/read-file", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error((await res.text()) || "Could not read that file.");
  }
  return res.json();
}

export async function readWord(file: File): Promise<Result> {
  const form = new FormData();
  form.append("file", file);
  return post(form);
}

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not draw the page."))),
      "image/jpeg",
      0.88
    )
  );

// A photo or scan of a page.
export async function readImage(file: File): Promise<Result> {
  // Shrink very large photos: more pixels than this do not help the reader.
  // (A small photo goes as it is; the server enlarges it.)
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const form = new FormData();
  form.append("page", await toJpeg(canvas), "page.jpg");
  form.append("layer", "");
  const { pages, gaps } = await post(form);
  return { ...limit(String(pages?.[0] ?? "").trim()), gaps: gaps === true };
}

export async function readPdf(file: File): Promise<Result> {
  // Loaded only when a PDF is actually opened: it is a large library.
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: "/pdfjs/cmaps/",
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
  });
  const pdf = await task.promise;

  try {
    const count = Math.min(pdf.numPages, MAX_PAGES);
    const texts: (string | null)[] = []; // null = waiting for the reader
    const form = new FormData();
    const pictured: number[] = [];
    let ready = 0; // characters already known, to stop once there is enough

    for (let number = 1; number <= count; number++) {
      const page = await pdf.getPage(number);

      // The text stored in the PDF for this page, line by line.
      const content = await page.getTextContent();
      let stored = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        stored += item.str + (item.hasEOL ? "\n" : "");
      }
      stored = stored.replace(/[ \t]+\n/g, "\n").trim();

      if (stored.length >= 20 && !ARABIC_SCRIPT.test(stored)) {
        texts.push(stored);
        ready += stored.length;
      } else {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(MAX_SCALE, PAGE_WIDTH / base.width),
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        form.append("page", await toJpeg(canvas), `page-${number}.jpg`);
        form.append("layer", stored);
        pictured.push(texts.length);
        texts.push(null);
        // A page read from its picture: assume a modest amount of text, so
        // that enough pages are sent to fill the script.
        ready += Math.max(stored.length, 600);
      }
      page.cleanup();
      if (ready >= MAX_INPUT_LENGTH) break;
    }

    let gaps = false;
    if (pictured.length) {
      const { pages, gaps: unread } = await post(form);
      gaps = unread === true;
      pictured.forEach((slot, i) => {
        texts[slot] = String(pages?.[i] ?? "").trim();
      });
    }

    const text = texts.filter(Boolean).join("\n\n").trim();
    const result: Result = { ...limit(text), gaps };
    // Pages that were never opened also count as "there was more".
    if (pdf.numPages > texts.length) result.truncated = true;
    return result;
  } finally {
    task.destroy();
  }
}
