import { NextRequest } from "next/server";
import { mapLimit } from "@/lib/chunks";
import { docxText } from "@/lib/docx";
import { MAX_INPUT_LENGTH, MAX_UPLOAD_BYTES } from "@/lib/limits";
import { preparePage } from "@/lib/pageImages";
import { EngineError, route } from "@/lib/router/core";
import { hasOpenAI } from "@/lib/router/engines";
import { pageCandidates } from "@/lib/router/text";
import { overLimit } from "@/lib/usage";

// Turns an uploaded document into text.
//
//   POST /api/read-file   (multipart form)
//     file = a Word file (.docx)                 -> { text }
//     page = pictures of pages, one or more      -> { pages: [text, …], gaps }
//     layer = for each page, the text stored in the PDF for it (may be "")
//
// Word files are unpacked here. PDFs and photos arrive as pictures of their
// pages (the browser renders the PDF) and are read by a gpt-6.2 vision
// model: the text stored inside an Urdu PDF has its letters in a scrambled
// order, so it cannot be used as the text, only to check the reading against.
//
// A scan or a photo may be old, torn, faded or blurred, so it is prepared
// first (see pageImages.ts) and the reader marks every word it cannot make
// out with […] instead of guessing. `gaps` is true when any page has such
// marks or could not be read at all.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PAGES = 8;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const GAP = "[…]"; // stands where a word could not be read

const COPY_RULES = `Copy out its text exactly as written, in the same language and script, in reading order (Urdu and Arabic read right to left). Do not translate, summarise, correct or comment. Leave out page numbers, running headers and footers. Put a blank line between paragraphs. If the page has no text, use an empty string. Give the result by calling the save_page_text tool.`;

// A page drawn from a PDF's own text: always sharp.
const READ_CLEAN_PAGE = `This is a picture of one page of a document. ${COPY_RULES}`;

// A scan or a photo of paper.
const READ_PAPER_PAGE = `The two pictures show the same page of a document: first as it was scanned or photographed, then after cleaning. The page may be damaged: blurred, faded, stained, torn, creased or photographed at an angle. Use whichever picture shows each word more clearly, and write the page once. Use the shape of each word and the sense of the sentence to make out words that are hard to see, but never invent text: where a word is torn away or cannot be read at all, write ${GAP} in its place. ${COPY_RULES}`;

const LETTER = /[؀-ۿA-Za-z]/g;

function letterCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of text.match(LETTER) ?? []) {
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  }
  return counts;
}

// How far two texts are made of the same letters (0 to 1), whatever their
// order. The text stored in a PDF has the right letters even when their
// order is scrambled, so a faithful reading of the page scores close to 1
// and an invented one does not (measured: 0.95 to 0.99 against 0.82).
function sameLetters(a: string, b: string): number {
  const ca = letterCounts(a);
  const cb = letterCounts(b);
  let shared = 0;
  let totalA = 0;
  let totalB = 0;
  for (const n of ca.values()) totalA += n;
  for (const [letter, n] of cb) {
    totalB += n;
    shared += Math.min(n, ca.get(letter) ?? 0);
  }
  return shared / Math.max(1, totalA, totalB);
}

type Page = { text: string; gaps: boolean };

async function readPage(image: File, layer: string): Promise<Page> {
  const bytes = Buffer.from(await image.arrayBuffer());
  // Enough stored letters means the page was drawn from the PDF's own text.
  const drawn = (layer.match(LETTER) ?? []).length >= 40;

  let pictures: string[];
  try {
    pictures = drawn
      ? [`data:${image.type || "image/jpeg"};base64,${bytes.toString("base64")}`]
      : await preparePage(bytes);
  } catch {
    throw new EngineError("That picture could not be opened.", 415);
  }

  const { value } = await route(
    "read",
    pageCandidates(
      drawn ? READ_CLEAN_PAGE : READ_PAPER_PAGE,
      pictures,
      ({ text, legibility }) => {
        if (drawn && sameLetters(layer, text.replaceAll(GAP, "")) < 0.9) {
          // Not the letters that are on the page: do not trust this reading.
          throw new EngineError("the reading does not match the page");
        }
        return {
          text,
          gaps: legibility === "unreadable" || text.includes(GAP),
        };
      }
    )
  );
  return value;
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("Invalid request", { status: 400 });
  }

  // ------------------------------------------------------------ Word
  const file = form.get("file");
  if (file instanceof File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return new Response("The file is larger than 25 MB.", { status: 413 });
    }
    if (/\.doc$/i.test(file.name)) {
      return new Response(
        "Old .doc files cannot be read. Open it in Word and save it as .docx.",
        { status: 415 }
      );
    }
    const text = docxText(Buffer.from(await file.arrayBuffer()));
    if (text === null) {
      return new Response("That is not a readable Word (.docx) file.", {
        status: 415,
      });
    }
    return Response.json({
      text: text.slice(0, MAX_INPUT_LENGTH - 1),
      truncated: text.length > MAX_INPUT_LENGTH - 1,
    });
  }

  // ------------------------------------------- pictures of pages
  const pages = form.getAll("page").filter((p): p is File => p instanceof File);
  const layers = form.getAll("layer").map((l) => (typeof l === "string" ? l : ""));
  if (!pages.length) {
    return new Response("No file was uploaded.", { status: 400 });
  }
  if (pages.length > MAX_PAGES || pages.some((p) => p.size > MAX_PAGE_BYTES)) {
    return new Response("Too many pages, or a page picture is too large.", {
      status: 413,
    });
  }
  if (pages.some((p) => !p.type.startsWith("image/"))) {
    return new Response("Pages must be pictures.", { status: 415 });
  }
  if (!hasOpenAI()) {
    return new Response("OPENAI_API_KEY is not set in .env", { status: 401 });
  }

  const limited = overLimit("file", req);
  if (limited) return limited;

  try {
    const read = await mapLimit(pages, 3, (page, i) =>
      readPage(page, layers[i] ?? "")
    );
    return Response.json({
      pages: read.map((page) => page.text),
      gaps: read.some((page) => page.gaps),
    });
  } catch (err) {
    console.error("Could not read the uploaded pages:", err);
    return new Response("Could not read that document.", {
      status: err instanceof EngineError ? err.status ?? 502 : 500,
    });
  }
}
