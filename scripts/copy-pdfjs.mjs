// Copies the parts of the PDF reader that the browser loads by URL (its
// worker, fonts and decoders) from node_modules into public/pdfjs. Runs
// after every install, so the copies always match the installed version.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "public", "pdfjs");

if (!existsSync(from)) {
  console.log("pdfjs-dist is not installed; nothing to copy.");
  process.exit(0);
}

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(join(from, "build", "pdf.worker.min.mjs"), join(to, "pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
  cpSync(join(from, folder), join(to, folder), { recursive: true });
}
console.log("PDF reader files copied to public/pdfjs");
