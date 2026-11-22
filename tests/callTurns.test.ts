import assert from "node:assert/strict";
import { test } from "node:test";
import { CallTurns, transcriptSpan } from "../src/lib/callTurns";

test("a confirmed caller interrupts the active line and late fragments cannot restart it", () => {
  const updates: string[] = [];
  const turns = new CallTurns({
    update: (text) => updates.push(text),
    clear: () => updates.push("<clear>"),
  });

  turns.assistant("Sala", transcriptSpan(100, 190));
  turns.assistant("am!", transcriptSpan(190, 300));
  assert.equal(updates.at(-1), "Salaam!");
  assert.equal(turns.caller(transcriptSpan(0, 80), true), false);
  assert.equal(turns.caller(transcriptSpan(310, 350), false), false);
  assert.equal(turns.caller(transcriptSpan(350, 470), true), true);
  assert.equal(turns.waitingForReply, true);
  assert.equal(turns.assistant("late", transcriptSpan(275, 400)), false);
  assert.equal(updates.at(-1), "<clear>");

  turns.assistant("جی", transcriptSpan(480, 670));
  assert.equal(turns.waitingForReply, false);
  assert.equal(updates.at(-1), "جی");
  turns.assistant("آج", transcriptSpan(2200, 2400));
  assert.deepEqual(updates.slice(-2), ["<clear>", "آج"]);
});
