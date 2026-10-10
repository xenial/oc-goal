import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GoalStore,
  MemoryStorageBackend,
  goalTokenDeltaForUsage,
  validateGoalBudget,
  validateThreadGoalObjective,
} from "../dist/store.js";

function newStore() {
  return new GoalStore(new MemoryStorageBackend());
}
const T = "thread-1";

test("replace, update and get thread goal", async () => {
  const s = newStore();
  const goal = await s.replaceThreadGoal(T, "optimize the benchmark", "active", 100_000);
  assert.equal(goal.status, "active");
  assert.equal(goal.tokensUsed, 0);
  assert.deepEqual(await s.getThreadGoal(T), goal);

  const updated = await s.updateThreadGoal(T, { status: "paused", tokenBudget: 200_000 });
  assert.equal(updated.status, "paused");
  assert.equal(updated.tokenBudget, 200_000);

  const replaced = await s.replaceThreadGoal(T, "ship the new result", "active", null);
  assert.equal(replaced.objective, "ship the new result");
  assert.equal(replaced.status, "active");
  assert.equal(replaced.tokenBudget, null);
  assert.equal(replaced.tokensUsed, 0);

  assert.deepEqual(await s.deleteThreadGoal(T), replaced);
  assert.equal(await s.getThreadGoal(T), null);
  assert.equal(await s.deleteThreadGoal(T), null);
});

test("replace applies budget limit immediately when budget is 0/used", async () => {
  const s = newStore();
  const g = await s.replaceThreadGoal(T, "stay within budget", "active", 0);
  // budget 0 => tokensUsed(0) >= 0 => budget_limited
  assert.equal(g.status, "budget_limited");
});

test("insert does not replace existing unfinished goal", async () => {
  const s = newStore();
  const inserted = await s.insertThreadGoal(T, "optimize the benchmark", "active", 100_000);
  assert.ok(inserted);
  const dup = await s.insertThreadGoal(T, "replace the benchmark", "active", 200_000);
  assert.equal(dup, null);
  assert.deepEqual(await s.getThreadGoal(T), inserted);
});

test("insert replaces a completed goal", async () => {
  const s = newStore();
  await s.insertThreadGoal(T, "first", "active", null);
  await s.updateThreadGoal(T, { status: "complete" });
  const again = await s.insertThreadGoal(T, "second", "active", null);
  assert.ok(again);
  assert.equal(again.objective, "second");
});

test("update ignores replaced goal version (CAS)", async () => {
  const s = newStore();
  const original = await s.replaceThreadGoal(T, "old objective", "active", 100);
  const replacement = await s.replaceThreadGoal(T, "new objective", "active", 10);

  const stale = await s.updateThreadGoal(T, {
    status: "complete",
    expectedGoalId: original.goalId,
  });
  assert.equal(stale, null);
  assert.deepEqual(await s.getThreadGoal(T), replacement);

  const fresh = await s.updateThreadGoal(T, {
    status: "complete",
    expectedGoalId: replacement.goalId,
  });
  assert.equal(fresh.status, "complete");
});

test("objective update preserves usage and createdAt", async () => {
  const s = newStore();
  const g0 = await s.replaceThreadGoal(T, "draft the report", "active", 100);
  const acc = await s.accountThreadGoalUsage(T, 12, 30, "active_only", null);
  assert.equal(acc.kind, "updated");

  const updated = await s.updateThreadGoal(T, {
    objective: "draft the report clearly",
    status: "paused",
    tokenBudget: 200,
    expectedGoalId: g0.goalId,
  });
  assert.equal(updated.objective, "draft the report clearly");
  assert.equal(updated.status, "paused");
  assert.equal(updated.tokenBudget, 200);
  assert.equal(updated.tokensUsed, 30);
  assert.equal(updated.timeUsedSeconds, 12);
  assert.equal(updated.createdAtMs, g0.createdAtMs);
});

test("pause active goal does not clobber terminal status", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "optimize", "active", 100_000);
  const paused = await s.pauseActiveThreadGoal(T);
  assert.equal(paused.status, "paused");

  await s.updateThreadGoal(T, { status: "complete" });
  const again = await s.pauseActiveThreadGoal(T);
  assert.equal(again, null);
  assert.equal((await s.getThreadGoal(T)).status, "complete");
});

test("usage_limit transitions active and budget_limited, not others", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "optimize", "active", null);
  const ul = await s.usageLimitActiveThreadGoal(T);
  assert.equal(ul.status, "usage_limited");
  assert.equal(await s.usageLimitActiveThreadGoal(T), null);

  // budget_limited -> usage_limited
  await s.replaceThreadGoal(T, "keep", "active", 1);
  await s.accountThreadGoalUsage(T, 1, 5, "active_only", null); // crosses budget
  assert.equal((await s.getThreadGoal(T)).status, "budget_limited");
  const ul2 = await s.usageLimitActiveThreadGoal(T);
  assert.equal(ul2.status, "usage_limited");
});

test("usage accounting: active, budget crossing, and in-flight budget_limited", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "stay within budget", "active", 20);

  let o = await s.accountThreadGoalUsage(T, 7, 5, "active_only", null);
  assert.equal(o.kind, "updated");
  assert.equal(o.goal.status, "active");
  assert.equal(o.goal.tokensUsed, 5);
  assert.equal(o.goal.timeUsedSeconds, 7);

  o = await s.accountThreadGoalUsage(T, 3, 15, "active_only", null);
  assert.equal(o.goal.status, "budget_limited");
  assert.equal(o.goal.tokensUsed, 20);
  assert.equal(o.goal.timeUsedSeconds, 10);

  // in-flight usage on a budget_limited goal still accounts under active_only
  o = await s.accountThreadGoalUsage(T, 5, 5, "active_only", null);
  assert.equal(o.goal.status, "budget_limited");
  assert.equal(o.goal.tokensUsed, 25);
});

test("active_status_only does not update budget_limited goals", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "stay stopped", "active", 20);
  await s.accountThreadGoalUsage(T, 1, 50, "active_only", null); // -> budget_limited
  const o = await s.accountThreadGoalUsage(T, 5, 5, "active_status_only", null);
  assert.equal(o.kind, "unchanged");
  assert.equal(o.goal.status, "budget_limited");
  assert.equal(o.goal.tokensUsed, 50);
});

test("stopped accounting promotes paused goal over budget", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "stop before overrun", "active", 20);
  await s.updateThreadGoal(T, { status: "paused" });
  const o = await s.accountThreadGoalUsage(T, 3, 25, "active_or_stopped", null);
  assert.equal(o.kind, "updated");
  assert.equal(o.goal.status, "budget_limited");
  assert.equal(o.goal.tokensUsed, 25);
});

test("lowering budget below usage flips active to budget_limited", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "stay within budget", "active", 100);
  await s.accountThreadGoalUsage(T, 1, 50, "active_only", null);
  const lowered = await s.updateThreadGoal(T, { tokenBudget: 40 });
  assert.equal(lowered.status, "budget_limited");
  assert.equal(lowered.tokenBudget, 40);
  assert.equal(lowered.tokensUsed, 50);
});

test("reactivating an over-budget goal keeps it budget_limited", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "stay within budget", "active", 40);
  await s.accountThreadGoalUsage(T, 1, 50, "active_only", null);
  const reactivated = await s.updateThreadGoal(T, {
    objective: "stay within budget, with clearer wording",
    status: "active",
  });
  assert.equal(reactivated.status, "budget_limited");
  assert.equal(reactivated.tokensUsed, 50);
});

test("pausing a budget_limited goal preserves terminal status", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "stay within budget", "active", 40);
  await s.accountThreadGoalUsage(T, 1, 50, "active_only", null);
  const paused = await s.updateThreadGoal(T, { status: "paused" });
  assert.equal(paused.status, "budget_limited");
});

test("blocking a budget_limited goal preserves terminal status", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "stay within budget", "active", 40);
  await s.accountThreadGoalUsage(T, 1, 50, "active_only", null);
  const blocked = await s.updateThreadGoal(T, { status: "blocked" });
  assert.equal(blocked.status, "budget_limited");
});

test("active_or_complete finalizes a completed goal; active_only does not", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "finish the report", "active", 1000);
  await s.updateThreadGoal(T, { status: "complete" });

  const activeOnly = await s.accountThreadGoalUsage(T, 30, 200, "active_only", null);
  assert.equal(activeOnly.kind, "unchanged");
  assert.equal(activeOnly.goal.status, "complete");
  assert.equal(activeOnly.goal.tokensUsed, 0);

  const completing = await s.accountThreadGoalUsage(T, 30, 200, "active_or_complete", null);
  assert.equal(completing.kind, "updated");
  assert.equal(completing.goal.status, "complete");
  assert.equal(completing.goal.tokensUsed, 200);
});

test("active_or_stopped accounts in-flight usage for a paused goal", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "finish the report", "active", 1000);
  await s.updateThreadGoal(T, { status: "paused" });

  const activeOnly = await s.accountThreadGoalUsage(T, 30, 200, "active_only", null);
  assert.equal(activeOnly.kind, "unchanged");

  const inFlight = await s.accountThreadGoalUsage(T, 30, 200, "active_or_stopped", null);
  assert.equal(inFlight.kind, "updated");
  assert.equal(inFlight.goal.status, "paused");
  assert.equal(inFlight.goal.tokensUsed, 200);
});

test("usage accounting ignores replaced goal version", async () => {
  const s = newStore();
  const original = await s.replaceThreadGoal(T, "old", "active", 100);
  const replacement = await s.replaceThreadGoal(T, "new", "active", 10);
  const o = await s.accountThreadGoalUsage(T, 5, 5, "active_only", original.goalId);
  assert.equal(o.kind, "unchanged");
  assert.equal(o.goal.goalId, replacement.goalId);
  assert.equal(o.goal.tokensUsed, 0);
});

test("concurrent usage accounting preserves every delta", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "count every token", "active", 1000);
  const a = s.accountThreadGoalUsage(T, 4, 40, "active_only", null);
  const b = s.accountThreadGoalUsage(T, 6, 60, "active_only", null);
  await Promise.all([a, b]);
  const g = await s.getThreadGoal(T);
  assert.equal(g.tokensUsed, 100);
  assert.equal(g.timeUsedSeconds, 10);
});

// --- validation & token delta ---

test("validateThreadGoalObjective", () => {
  assert.ok(validateThreadGoalObjective(""));
  assert.ok(validateThreadGoalObjective("x".repeat(4001)));
  assert.equal(validateThreadGoalObjective("ship it"), null);
});

test("validateGoalBudget", () => {
  assert.ok(validateGoalBudget(0, null));
  assert.ok(validateGoalBudget(-5, null));
  assert.equal(validateGoalBudget(10, null), null);
  assert.ok(validateGoalBudget(200, 100));
  assert.equal(validateGoalBudget(50, 100), null);
});

test("OpenCode accounting includes reasoning and cache writes, excludes cache reads", () => {
  const d = goalTokenDeltaForUsage({ input: 1000, output: 250, reasoning: 200, cache: { read: 300, write: 100 } });
  assert.equal(d, 1550);
});

test("concurrent creates only insert one unfinished goal", async () => {
  const s = newStore();
  const results = await Promise.all([
    s.insertThreadGoal(T, "first", "active", null),
    s.insertThreadGoal(T, "second", "active", null),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("an explicit null budget clears it, omission preserves it", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "task", "active", 100);
  assert.equal((await s.updateThreadGoal(T, { status: "paused" })).tokenBudget, 100);
  assert.equal((await s.updateThreadGoal(T, { tokenBudget: null })).tokenBudget, null);
});

test("replacement wins over older accounting and cannot be resurrected by stale writers", async () => {
  const s = newStore();
  const old = await s.replaceThreadGoal(T, "old", "active", 100);
  await Promise.all([
    s.accountThreadGoalUsage(T, 1, 20, "active_only", old.goalId),
    s.replaceThreadGoal(T, "new", "active", 200),
    s.updateThreadGoal(T, { status: "complete", expectedGoalId: old.goalId }),
  ]);
  const goal = await s.getThreadGoal(T);
  assert.equal(goal.objective, "new");
  assert.equal(goal.tokensUsed, 0);
  assert.equal(goal.status, "active");
});

test("cleared state cannot be resurrected by earlier accounting", async () => {
  const s = newStore();
  await s.replaceThreadGoal(T, "task", "active", null);
  await Promise.all([s.accountThreadGoalUsage(T, 1, 20, "active_only"), s.deleteThreadGoal(T)]);
  assert.equal(await s.getThreadGoal(T), null);
});

test("goal budget validation rejects non-finite, fractional and unsafe values", () => {
  for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.ok(validateGoalBudget(value, null));
});
