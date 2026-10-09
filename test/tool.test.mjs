import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalStore, MemoryStorageBackend } from "../dist/store.js";
import { GoalToolHandlers, ToolError } from "../dist/tool.js";

const T = "thread-1";

function setup(maxBudget = null) {
  const store = new GoalStore(new MemoryStorageBackend());
  const handlers = new GoalToolHandlers(store, maxBudget);
  return { store, handlers };
}

test("get returns null when no goal", async () => {
  const { handlers } = setup();
  const res = await handlers.get(T);
  assert.equal(res.goal, null);
  assert.equal(res.remainingTokens, null);
});

test("create + get roundtrip with remaining tokens", async () => {
  const { store, handlers } = setup();
  const created = await handlers.create(T, { objective: "ship feature X", token_budget: 5000 });
  assert.equal(created.goal.status, "active");
  assert.equal(created.remainingTokens, 5000);

  await store.accountThreadGoalUsage(T, 0, 1200, "active_only", null);
  const res = await handlers.get(T);
  assert.equal(res.goal.tokensUsed, 1200);
  assert.equal(res.remainingTokens, 3800);
});

test("create fails when an unfinished goal exists", async () => {
  const { handlers } = setup();
  await handlers.create(T, { objective: "first" });
  await assert.rejects(() => handlers.create(T, { objective: "second" }), ToolError);
});

test("create succeeds after complete", async () => {
  const { handlers } = setup();
  await handlers.create(T, { objective: "first" });
  await handlers.update(T, { status: "complete" });
  const res = await handlers.create(T, { objective: "second" });
  assert.equal(res.goal.objective, "second");
});

test("create rejects empty objective", async () => {
  const { handlers } = setup();
  await assert.rejects(() => handlers.create(T, { objective: "   " }), ToolError);
});

test("create rejects non-positive budget", async () => {
  const { handlers } = setup();
  await assert.rejects(
    () => handlers.create(T, { objective: "x", token_budget: 0 }),
    ToolError,
  );
});

test("create applies max budget default and cap", async () => {
  const { handlers } = setup(10_000);
  // omitted budget -> falls back to max
  const res = await handlers.create(T, { objective: "x" });
  assert.equal(res.goal.tokenBudget, 10_000);
  // exceeding budget -> error
  const { handlers: h2 } = setup(100);
  await assert.rejects(() => h2.create(T, { objective: "y", token_budget: 500 }), ToolError);
});

test("update only accepts complete/blocked/paused", async () => {
  const { handlers } = setup();
  await handlers.create(T, { objective: "x" });
  await assert.rejects(() => handlers.update(T, { status: "active" }), ToolError);
  await assert.rejects(() => handlers.update(T, { status: "usage_limited" }), ToolError);
  await assert.rejects(() => handlers.update(T, { status: "budget_limited" }), ToolError);
  const ok = await handlers.update(T, { status: "complete" });
  assert.equal(ok.goal.status, "complete");
});

test("update with no goal errors", async () => {
  const { handlers } = setup();
  await assert.rejects(() => handlers.update(T, { status: "complete" }), ToolError);
});

test("complete includes completion budget report when budget/time present", async () => {
  const { handlers } = setup();
  await handlers.create(T, { objective: "x", token_budget: 1000 });
  const res = await handlers.update(T, { status: "complete" });
  assert.equal(res.goal.status, "complete");
  assert.ok(res.completionBudgetReport);
});

test("complete without budget and zero time omits report", async () => {
  const { handlers } = setup();
  await handlers.create(T, { objective: "x" });
  const res = await handlers.update(T, { status: "complete" });
  assert.equal(res.completionBudgetReport, null);
});

test("paused update omits completion report", async () => {
  const { handlers } = setup();
  await handlers.create(T, { objective: "x", token_budget: 1000 });
  const res = await handlers.update(T, { status: "paused" });
  assert.equal(res.completionBudgetReport, null);
});
