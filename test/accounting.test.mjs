import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalAccountingState, shouldClearActiveGoal, toolAttemptCountsForGoalProgress } from "../dist/accounting.js";

const base = { input: 0, output: 0, cache: { read: 0, write: 0 } };
const usage = (input, output, read = 0) => ({ input, output, cache: { read, write: 0 } });

test("progress snapshot: OpenCode input is already uncached", () => {
  const a = new GoalAccountingState();
  a.startTurn("t1", true, usage(0, 0));
  a.markTurnGoalActive("t1", "g1");
  a.recordTokenUsage("t1", usage(1000, 250, 300));
  const snap = a.progressSnapshot("t1");
  assert.equal(snap.expectedGoalId, "g1");
  assert.equal(snap.tokenDelta, 1250);
});

test("no snapshot without an active goal", () => {
  const a = new GoalAccountingState();
  a.startTurn("t1", true, usage(0, 0));
  a.recordTokenUsage("t1", usage(500, 100));
  assert.equal(a.progressSnapshot("t1"), null);
});

test("accounting advances the baseline", () => {
  const a = new GoalAccountingState();
  a.startTurn("t1", true, usage(0, 0));
  a.markTurnGoalActive("t1", "g1");
  a.recordTokenUsage("t1", usage(100, 10));
  const s1 = a.progressSnapshot("t1");
  assert.equal(s1.tokenDelta, 110);
  a.markProgressAccountedForStatus("t1", s1, "active", false);
  // second snapshot from same usage => zero delta => null (time also 0)
  const s2 = a.progressSnapshot("t1");
  assert.equal(s2 === null || s2.tokenDelta === 0, true);
  a.recordTokenUsage("t1", usage(200, 20));
  const s3 = a.progressSnapshot("t1");
  assert.equal(s3.tokenDelta, 110);
});

test("empty response threshold: 3 consecutive empties on an automatic turn", () => {
  const a = new GoalAccountingState();
  for (let i = 0; i < 3; i++) {
    const turnId = `t${i}`;
    a.startTurn(turnId, true, base);
    a.markTurnGoalActive(turnId, "g1");
    a.markGoalContinuation(turnId); // automatic
    a.recordActivity(turnId, false, true); // empty final
    const r = a.emptyResponseGoal(turnId);
    if (i < 2) assert.equal(r, null, `turn ${i} should not trigger`);
    else assert.equal(r, "g1", "third consecutive empty turn triggers");
    a.finishTurn(turnId);
  }
});

test("activity resets empty streak", () => {
  const a = new GoalAccountingState();
  for (let i = 0; i < 2; i++) {
    const t = `t${i}`;
    a.startTurn(t, true, base);
    a.markTurnGoalActive(t, "g1");
    a.markGoalContinuation(t);
    a.recordActivity(t, false, true);
    assert.equal(a.emptyResponseGoal(t), null);
    a.finishTurn(t);
  }
  // a turn with real activity resets
  const t3 = "t3";
  a.startTurn(t3, true, base);
  a.markTurnGoalActive(t3, "g1");
  a.markGoalContinuation(t3);
  a.recordActivity(t3, true, false);
  assert.equal(a.emptyResponseGoal(t3), null);
  a.finishTurn(t3);
  // need 3 fresh empties
  for (let i = 4; i < 7; i++) {
    const t = `t${i}`;
    a.startTurn(t, true, base);
    a.markTurnGoalActive(t, "g1");
    a.markGoalContinuation(t);
    a.recordActivity(t, false, true);
    const r = a.emptyResponseGoal(t);
    if (i < 6) assert.equal(r, null);
    else assert.equal(r, "g1");
    a.finishTurn(t);
  }
});

test("exec failure threshold: 3 consecutive without a successful tool", () => {
  const a = new GoalAccountingState();
  for (let i = 0; i < 3; i++) {
    const t = `t${i}`;
    a.startTurn(t, true, base);
    a.markTurnGoalActive(t, "g1");
    a.recordToolOutcome(t, "exec", { kind: "failed", handlerExecuted: true });
    const r = a.executionFailureGoal(t);
    if (i < 2) assert.equal(r, null);
    else assert.equal(r, "g1");
    a.finishTurn(t);
  }
});

test("successful tool resets exec failure streak", () => {
  const a = new GoalAccountingState();
  for (let i = 0; i < 2; i++) {
    const t = `t${i}`;
    a.startTurn(t, true, base);
    a.markTurnGoalActive(t, "g1");
    a.recordToolOutcome(t, "exec", { kind: "failed", handlerExecuted: true });
    assert.equal(a.executionFailureGoal(t), null);
    a.finishTurn(t);
  }
  const t3 = "t3";
  a.startTurn(t3, true, base);
  a.markTurnGoalActive(t3, "g1");
  a.recordToolOutcome(t3, "read", { kind: "completed", success: true });
  assert.equal(a.executionFailureGoal(t3), null);
  a.finishTurn(t3);
  for (let i = 4; i < 7; i++) {
    const t = `t${i}`;
    a.startTurn(t, true, base);
    a.markTurnGoalActive(t, "g1");
    a.recordToolOutcome(t, "exec", { kind: "failed", handlerExecuted: true });
    const r = a.executionFailureGoal(t);
    if (i < 6) assert.equal(r, null);
    else assert.equal(r, "g1");
    a.finishTurn(t);
  }
});

test("shouldClearActiveGoal", () => {
  assert.equal(shouldClearActiveGoal("active", "keep_active"), false);
  assert.equal(shouldClearActiveGoal("budget_limited", "keep_active"), false);
  assert.equal(shouldClearActiveGoal("budget_limited", "clear_active"), true);
  assert.equal(shouldClearActiveGoal("paused", "keep_active"), true);
  assert.equal(shouldClearActiveGoal("complete", "keep_active"), true);
  assert.equal(shouldClearActiveGoal("blocked", "clear_active"), true);
});

test("toolAttemptCountsForGoalProgress", () => {
  assert.equal(toolAttemptCountsForGoalProgress({ kind: "completed", success: true }), true);
  assert.equal(toolAttemptCountsForGoalProgress({ kind: "completed", success: false }), true);
  assert.equal(toolAttemptCountsForGoalProgress({ kind: "failed", handlerExecuted: true }), true);
  assert.equal(toolAttemptCountsForGoalProgress({ kind: "failed", handlerExecuted: false }), false);
  assert.equal(toolAttemptCountsForGoalProgress({ kind: "blocked" }), false);
  assert.equal(toolAttemptCountsForGoalProgress({ kind: "aborted" }), false);
});

test("clearCurrentTurnGoal resets active goal and streaks", () => {
  const a = new GoalAccountingState();
  a.startTurn("t1", true, base);
  a.markTurnGoalActive("t1", "g1");
  const tid = a.clearCurrentTurnGoal();
  assert.equal(tid, "t1");
  assert.equal(a.currentActiveGoalIdForTurn("t1"), null);
});

test("plan-mode turns do not account tokens", () => {
  const a = new GoalAccountingState();
  a.startTurn("t1", false, base); // accountTokens=false (plan mode)
  a.markTurnGoalActive("t1", "g1");
  a.recordTokenUsage("t1", usage(1000, 500));
  assert.equal(a.progressSnapshot("t1"), null);
});

test("accounting a captured snapshot preserves usage observed after it", () => {
  const a = new GoalAccountingState();
  a.startTurn("t1", true);
  a.markTurnGoalActive("t1", "g1");
  a.recordTokenUsage("t1", usage(100, 10));
  const snapshot = a.progressSnapshot("t1");
  a.recordTokenUsage("t1", usage(200, 20));
  a.markProgressAccountedForStatus("t1", snapshot, "active", false);
  assert.equal(a.progressSnapshot("t1").tokenDelta, 110);
});
