import assert from "node:assert/strict";
import { test } from "node:test";
import { MotionTurn, motionQuery, motionResult, readMotionPiece } from "../src/lib/avatar/motion";

test("pose pieces use the same 16 kHz clock across a director split and a retry", () => {
  const turn = new MotionTurn(14.2);
  const first = turn.piece(14.2);
  const split = turn.piece(14.2 + 588 / 14700);
  const next = turn.piece(14.2 + 5880 / 14700);
  assert.deepEqual([first.seq, split.seq, next.seq], [0, 1, 2]);
  assert.deepEqual([first.at, split.at, next.at], [0, 640, 6400]);
  for (const piece of [first, split, next]) {
    assert.equal(piece.motion, turn.id);
    assert.deepEqual(readMotionPiece(new URLSearchParams(motionQuery(piece))), piece);
  }
  assert.notEqual(new MotionTurn(14.6).id, turn.id);
  assert.equal(motionQuery(), "");
});

test("missing or malformed optional metadata leaves the speech renderer usable", () => {
  const good = new MotionTurn(1).piece(1);
  for (const [name, value] of [["motion", "bad-id"], ["at", "-1"], ["at", "9999999999"], ["seq", ""]]) {
    const query = new URLSearchParams(motionQuery(good));
    query.set(name, value);
    assert.equal(readMotionPiece(query), undefined);
  }
  assert.deepEqual(["ditto", "pass", null, "unknown"].map(motionResult), ["ditto", "pass", null, null]);
});
