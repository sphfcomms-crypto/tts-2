import sharp from "sharp";

// Gets a picture of a page ready for the reader. Old, torn, faded or
// blurred pages are read far better from two pictures than from one:
//
//   1. the page as it is, enlarged so small letters cover more pixels;
//   2. a cleaned copy: grey, with the paper's colour, stains and uneven
//      light evened out and the contrast stretched, enlarged the same way.
//
// Measured on seven damaged Urdu pages, the two together beat every single
// picture tried. Neither picture is sharpened: sharpening puts rings round
// blurred letters and the reader then finds fewer words.

const LONG_SIDE = 2400; // pixels after enlarging
const MAX_ENLARGE = 2.5;
const WHITE = 235; // where the paper lands after the light is evened out
const SHRINK = 8; // the paper's shading is worked out on a small copy

const jpeg = (image: sharp.Sharp) =>
  image
    .jpeg({ quality: 88 })
    .toBuffer()
    .then((buf) => `data:image/jpeg;base64,${buf.toString("base64")}`);

// Stretches the grey levels so the darkest 1% become black and the lightest
// 2% white.
function stretch(pixels: Buffer) {
  const counts = new Uint32Array(256);
  for (let i = 0; i < pixels.length; i++) counts[pixels[i]]++;

  let low = 0;
  for (let seen = 0; low < 255; low++) {
    seen += counts[low];
    if (seen > pixels.length * 0.01) break;
  }
  let high = 255;
  for (let seen = 0; high > 0; high--) {
    seen += counts[high];
    if (seen > pixels.length * 0.02) break;
  }
  if (high <= low) return;

  const table = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    table[v] = Math.max(0, Math.min(255, Math.round(((v - low) * 255) / (high - low))));
  }
  for (let i = 0; i < pixels.length; i++) pixels[i] = table[pixels[i]];
}

// Returns the two pictures as data: URLs, the page as it is first.
export async function preparePage(bytes: Buffer): Promise<string[]> {
  // rotate() turns a phone photo the way its orientation tag says.
  const upright = await sharp(bytes).rotate().toBuffer({ resolveWithObject: true });
  const { width, height } = upright.info;
  const longSide = Math.max(width, height);

  let scale = Math.min(MAX_ENLARGE, LONG_SIDE / longSide);
  if (scale > 1 && scale < 1.05) scale = 1;
  const size = {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    kernel: "lanczos3" as const,
    fit: "fill" as const,
  };
  const resized = (image: sharp.Sharp) => (scale === 1 ? image : image.resize(size));

  const grey = await sharp(upright.data).greyscale().raw().toBuffer();

  // The paper without its writing: the page blurred until the letters are
  // gone. Blurring a small copy and enlarging it gives the same result fast.
  const paper = await sharp(grey, { raw: { width, height, channels: 1 } })
    .resize({
      width: Math.max(1, Math.round(width / SHRINK)),
      height: Math.max(1, Math.round(height / SHRINK)),
      fit: "fill",
    })
    .blur(Math.max(1, longSide / 28 / SHRINK))
    .resize({ width, height, fit: "fill", kernel: "cubic" })
    .raw()
    .toBuffer();

  // Dividing by the paper makes every part of the page equally light.
  const clean = Buffer.allocUnsafe(grey.length);
  for (let i = 0; i < grey.length; i++) {
    clean[i] = Math.min(255, (grey[i] / Math.max(1, paper[i])) * WHITE);
  }
  stretch(clean);

  return Promise.all([
    jpeg(resized(sharp(upright.data).flatten({ background: "#ffffff" }))),
    jpeg(resized(sharp(clean, { raw: { width, height, channels: 1 } }))),
  ]);
}
