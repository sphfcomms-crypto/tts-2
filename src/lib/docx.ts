import zlib from "node:zlib";

// Pulls the text out of a Word file (.docx). A .docx is a zip archive whose
// word/document.xml holds the text; this reads just that, with no library.

// Finds one file inside a zip archive and returns its bytes.
function unzipEntry(zip: Buffer, wanted: string): Buffer | null {
  // The table of contents is at the end; find its closing record.
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return null;
  const entries = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);

  for (let i = 0; i < entries; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(at + 10);
    const packedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);

    if (name === wanted) {
      if (zip.readUInt32LE(localAt) !== 0x04034b50) return null;
      const dataAt =
        localAt +
        30 +
        zip.readUInt16LE(localAt + 26) +
        zip.readUInt16LE(localAt + 28);
      const packed = zip.subarray(dataAt, dataAt + packedSize);
      if (method === 0) return packed;
      if (method === 8) return zlib.inflateRawSync(packed);
      return null;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point =
        code[1].toLowerCase() === "x"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code] ?? whole;
  });

// Returns the document's text, one paragraph per block, or null when the
// file is not a readable .docx.
export function docxText(file: Buffer): string | null {
  let xml: string;
  try {
    const entry = unzipEntry(file, "word/document.xml");
    if (!entry) return null;
    xml = entry.toString("utf8");
  } catch {
    return null;
  }

  // The pieces of a paragraph that are text: runs of text, tabs and line
  // breaks, in the order they appear. Everything else (formatting, field
  // codes, text deleted under "track changes") is skipped.
  const PIECE =
    /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;

  const paragraphs: string[] = [];
  for (const paragraph of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    let text = "";
    for (const piece of paragraph.matchAll(PIECE)) {
      if (piece[1] !== undefined) text += piece[1];
      else text += piece[0].startsWith("<w:tab") ? "\t" : "\n";
    }
    const clean = decode(text).trim();
    if (clean) paragraphs.push(clean);
  }
  return paragraphs.join("\n\n");
}
