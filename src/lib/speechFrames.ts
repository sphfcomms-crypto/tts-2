// Each speech frame contains three little-endian uint32s followed by UTF-8
// text and mono PCM16. The third integer counts silent samples AFTER the
// phrase. A zero header marks successful completion, including at exact
// frame boundaries where a network disconnect would otherwise look normal.
export const PIECE_MEDIA_TYPE = "application/x-tts-pieces";
const FRAME_BYTES = 12;

export function frameHeader(textBytes: number, audioBytes: number, gapSamples: number) {
  const bytes = new Uint8Array(FRAME_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, textBytes, true);
  view.setUint32(4, audioBytes, true);
  view.setUint32(8, gapSamples, true);
  return bytes;
}

// Network chunks need not line up with the WAV header, frame headers, UTF-8
// characters, or even PCM samples. Consume each network byte just once.
export class SpeechFrameReader {
  private chunk: Uint8Array = new Uint8Array(0);

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async bytes(count: number): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      if (!this.chunk.length) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("The speech stream ended early.");
        this.chunk = value;
      }
      const take = Math.min(this.chunk.length, count - offset);
      bytes.set(this.chunk.subarray(0, take), offset);
      this.chunk = this.chunk.subarray(take);
      offset += take;
    }
    return bytes;
  }

  async next() {
    const header = await this.bytes(FRAME_BYTES);
    const view = new DataView(header.buffer);
    const textLength = view.getUint32(0, true);
    const pcmLength = view.getUint32(4, true);
    const gapSamples = view.getUint32(8, true);
    if (textLength === 0 && pcmLength === 0 && gapSamples === 0) return null;
    // Bound allocations before reading a length from the network. These
    // limits cover the entire supported script and several minutes of PCM.
    if (!textLength || textLength > 64 * 1024 || pcmLength % 2 ||
        pcmLength > 32 * 1024 * 1024 || gapSamples > 24000) {
      throw new Error("Invalid speech frame.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await this.bytes(textLength));
    return { text, pcm: await this.bytes(pcmLength), gapSamples };
  }
}
