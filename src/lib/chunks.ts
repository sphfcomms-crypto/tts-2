// Splits long text into pieces a model can rewrite in one go, cutting only
// at paragraph and sentence ends, and puts the pieces back together.

export type Chunk = { text: string; paragraphEnd: boolean };

export function splitText(text: string, maxChars: number): Chunk[] {
  const chunks: Chunk[] = [];

  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // A sentence runs up to and including its closing punctuation.
    const sentences = trimmed.match(/[^۔؟?!.…\n]+[۔؟?!.…]*["”'’)]*\s*/g) ?? [
      trimmed,
    ];

    let current = "";
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > maxChars) {
        chunks.push({ text: current.trim(), paragraphEnd: false });
        current = "";
      }
      current += sentence;
      // One sentence longer than the limit: cut it at spaces.
      while (current.length > maxChars) {
        const cut = current.lastIndexOf(" ", maxChars);
        const at = cut > maxChars / 2 ? cut : maxChars;
        chunks.push({ text: current.slice(0, at).trim(), paragraphEnd: false });
        current = current.slice(at);
      }
    }
    if (current.trim()) {
      chunks.push({ text: current.trim(), paragraphEnd: false });
    }
    if (chunks.length) chunks[chunks.length - 1].paragraphEnd = true;
  }

  return chunks;
}

export const joinChunks = (chunks: Chunk[]): string =>
  chunks
    .map((chunk, i) =>
      i === chunks.length - 1
        ? chunk.text
        : chunk.text + (chunk.paragraphEnd ? "\n\n" : " ")
    )
    .join("");

// Runs `work` over the items, a few at a time, keeping the order.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index], index);
      }
    })
  );
  return results;
}
