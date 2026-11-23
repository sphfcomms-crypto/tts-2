const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MotionPiece = { motion: string; seq: number; at: number };
export type MotionResult = "ditto" | "pass" | null;

export const validMotionId = (id: string) => UUID.test(id);

export function motionResult(header: string | null): MotionResult {
  return header === "ditto" || header === "pass" ? header : null;
}

export function readMotionPiece(query: URLSearchParams): MotionPiece | undefined {
  const motion = query.get("motion") ?? "";
  const seq = query.get("seq") ?? "";
  const at = query.get("at") ?? "";
  if (!validMotionId(motion) || !/^\d{1,7}$/.test(seq) || !/^\d{1,10}$/.test(at) || Number(at) > 0x7fffffff) return;
  return { motion, seq: Number(seq), at: Number(at) };
}

export function motionQuery(piece?: MotionPiece): string {
  return piece ? `&motion=${piece.motion}&seq=${piece.seq}&at=${piece.at}` : "";
}

// Director cuts can split a single request at any frame. Keep offsets on
// a shared 16 kHz audio clock even on a device that captures at 44.1 kHz.
export class MotionTurn {
  readonly id = crypto.randomUUID();
  private seq = 0;
  constructor(private readonly firstAudioTime: number) {}

  piece(audioTime: number): MotionPiece {
    return { motion: this.id, seq: this.seq++, at: Math.round((audioTime - this.firstAudioTime) * 16000) };
  }
}
