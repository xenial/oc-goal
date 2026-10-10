import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, tokens, flush } from "./helpers/plugin.mjs";

test("settled step usage counts uncached input, reasoning and cache writes exactly once", async (t) => {
  const h = await harness(t);
  await h.emit("session.usage.updated", { tokens: tokens(50000, 5000) });
  await h.command("task");
  const id = await h.start();
  const value = tokens(100, 10, 300, 200, 40);
  await h.settle(value);
  await h.emit("session.step.ended", { assistantMessageID: id, tokens: value, finish: "stop" });
  await h.succeed();
  assert.equal(h.goal().tokensUsed, 350);
});

test("multiple steps and executions do not charge cumulative session totals", async (t) => {
  const h = await harness(t);
  await h.command("task");
  await h.start(); await h.settle(tokens(), "tool-calls"); await h.shell(true);
  await h.step(); await h.settle(); await h.succeed();
  await h.start(); await h.settle(); await h.succeed();
  assert.equal(h.goal().tokensUsed, 330);
});

test("user interruption pauses a goal and does not dispatch again", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.start(); await h.settle();
  const count = h.continuations().length;
  await h.emit("session.execution.interrupted", { reason: "user" });
  await h.emit("session.idle");
  assert.equal(h.goal().status, "paused");
  assert.equal(h.continuations().length, count);
  assert.equal(h.goal().tokensUsed, 110);
});

test("pause and clear controls interrupt running goal work", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.start(); await h.settle();
  await h.command("pause");
  assert.equal(h.goal().status, "paused");
  assert.equal(h.interrupts.length, 1);
  await h.command("clear");
  assert.equal(h.goal(), undefined);
  assert.equal(h.interrupts.length, 2);
});

test("plan mode neither consumes goal budget nor auto-continues", async (t) => {
  const h = await harness(t);
  await h.emit("session.agent.selected", { agent: "plan" });
  await h.command("task");
  assert.equal(h.continuations().length, 0);
  await h.start("plan"); await h.settle(); await h.succeed();
  assert.equal(h.goal().tokensUsed, 0);
  assert.equal(h.continuations().length, 0);
});

test("three empty automatic executions block a goal", async (t) => {
  const h = await harness(t);
  await h.command("task");
  for (let i = 0; i < 3; i++) {
    await h.start(); await h.emit("session.text.ended", { text: "" }); await h.settle(); await h.succeed();
    assert.equal(h.goal().status, i === 2 ? "blocked" : "active");
  }
  assert.equal(h.continuations().length, 3);
});

test("text-only automatic execution suppresses the next continuation", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.start();
  await h.emit("session.text.delta", { delta: "Still working" });
  await h.settle(); await h.succeed();
  assert.equal(h.goal().status, "active");
  assert.equal(h.continuations().length, 1);
  await h.command("resume");
  assert.equal(h.continuations().length, 2);
});

test("failed execution guard counts executions rather than individual steps", async (t) => {
  const h = await harness(t);
  await h.command("task");
  for (let turn = 0; turn < 3; turn++) {
    await h.start();
    for (let step = 0; step < 3; step++) {
      if (step) await h.step();
      await h.settle(tokens(), "tool-calls"); await h.shell(false);
    }
    await h.succeed();
    assert.equal(h.goal().status, turn === 2 ? "blocked" : "active");
  }
  await h.command("resume");
  await h.start(); await h.settle(tokens(), "tool-calls"); await h.shell(false); await h.succeed();
  assert.equal(h.goal().status, "active", "resume starts a fresh failure audit");
});

test("successful tool execution resets the failed command streak", async (t) => {
  const h = await harness(t);
  await h.command("task");
  for (const success of [false, false, true, false, false]) {
    await h.start(); await h.settle(tokens(), "tool-calls"); await h.shell(success); await h.succeed();
  }
  assert.equal(h.goal().status, "active");
});

test("completion retains final settled usage and the configured budget", async (t) => {
  const h = await harness(t, { maxGoalTokenBudget: 1000 });
  await h.command("task"); await h.start(); await h.settle(tokens(), "tool-calls");
  const response = await h.tool("update_goal", { status: "complete" });
  assert.equal(response.goal.tokenBudget, 1000);
  await h.step(); await h.settle(); await h.succeed();
  assert.equal(h.goal().status, "complete");
  assert.equal(h.goal().tokensUsed, 220);
  assert.equal(h.changes.at(-1).tokensUsed, 220);
});

test("pause retains usage that settles after the pause tool", async (t) => {
  const h = await harness(t, { maxGoalTokenBudget: 1000 });
  await h.command("task"); await h.start();
  await h.tool("update_goal", { status: "paused" });
  await h.settle(); await h.succeed();
  assert.equal(h.goal().status, "paused");
  assert.equal(h.goal().tokensUsed, 110);
});

test("crossing a budget sends one wrap-up and publishes the stopped status", async (t) => {
  const h = await harness(t, { maxGoalTokenBudget: 100 });
  await h.command("task"); await h.start(); await h.settle(); await h.succeed();
  assert.equal(h.goal().status, "budget_limited");
  assert.equal(h.goal().tokensUsed, 110);
  assert.equal(h.sent.filter((m) => m.metadata.purpose === "budget").length, 1);
  assert.equal(h.changes.at(-1).goalStatus, "budget_limited");
  assert.equal(h.continuations().length, 1);
});

test("failed step usage is charged before a transient execution error", async (t) => {
  const h = await harness(t);
  await h.command("task"); const id = await h.start();
  await h.emit("session.step.failed", { assistantMessageID: id, tokens: tokens(), error: { type: "NetworkError", message: "reset" } });
  await h.emit("session.execution.failed", { error: { type: "NetworkError", message: "reset" } });
  await h.emit("session.idle");
  assert.equal(h.goal().tokensUsed, 110);
  assert.equal(h.goal().status, "active");
  assert.equal(h.continuations().length, 2);
});

test("three repeated execution errors block, while quota errors stop immediately", async (t) => {
  const h = await harness(t);
  await h.command("task");
  for (let i = 0; i < 3; i++) {
    await h.start(); await h.emit("session.execution.failed", { error: { type: "NetworkError", message: "reset" } }); await h.emit("session.idle");
  }
  assert.equal(h.goal().status, "blocked");
  await h.command("resume"); await h.start();
  await h.emit("session.execution.failed", { error: { type: "APIError", message: "insufficient_quota" } });
  assert.equal(h.goal().status, "usage_limited");
});

test("replacing a running objective attributes subsequent usage to the new goal", async (t) => {
  const h = await harness(t);
  await h.command("old task"); await h.start(); await h.settle(tokens(), "tool-calls");
  await h.command("new task");
  assert.equal(h.goal().tokensUsed, 0);
  await h.step(); await h.settle(); await h.succeed();
  assert.equal(h.goal().objective, "new task");
  assert.equal(h.goal().tokensUsed, 110);
  assert.equal(h.sent.filter((m) => m.metadata.purpose === "objective").length, 1);
});

test("a first goal set mid-execution is visible to the model and accounted", async (t) => {
  const h = await harness(t);
  await h.start(); await h.command("new task"); await h.settle(); await h.succeed();
  assert.equal(h.goal().tokensUsed, 110);
  assert.ok(h.sent.some((m) => m.metadata.purpose === "objective"));
});

test("setting the same nonterminal objective preserves usage and goal identity", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.start(); await h.settle();
  const before = h.goal();
  await h.command("task");
  assert.equal(h.goal().goalId, before.goalId);
  assert.equal(h.goal().tokensUsed, before.tokensUsed);
});

test("server status, pause and clear notices never wake model execution", async (t) => {
  const h = await harness(t);
  await h.command("task");
  for (const text of ["status", "pause", "clear"]) {
    await h.commands.get("goal").execute({ sessionID: "s", prompt: { text } }); await flush();
    const notice = h.sent.at(-1);
    assert.equal(notice.metadata.purpose, "notice");
    assert.equal(notice.resume, false);
  }
});

test("disabled plugin cannot create goals through RPC and registers no tools", async (t) => {
  const h = await harness(t, { enabled: false });
  const reply = await h.command("task");
  assert.match(reply.message, /disabled/);
  assert.equal(h.goal(), undefined);
  assert.equal(h.tools.size, 0);
  assert.equal(h.commands.size, 0);
  assert.equal((await h.get()).status, "");
});

test("RPC validates objective length before changing existing state", async (t) => {
  const h = await harness(t);
  await h.command("task");
  await assert.rejects(h.command("x".repeat(4001)), /4000/);
  assert.equal(h.goal().objective, "task");
});

test("maximum continuation count pauses visibly instead of leaving an active stalled goal", async (t) => {
  const h = await harness(t, { maxContinuationTurns: 1 });
  await h.command("task"); await h.start(); await h.settle(tokens(), "tool-calls"); await h.shell(true); await h.succeed();
  assert.equal(h.goal().status, "paused");
  assert.match(h.sent.at(-1).text, /maxContinuationTurns/);
  assert.equal(h.sent.at(-1).resume, false);
});

test("queued user input prevents automatic continuation", async (t) => {
  const h = await harness(t);
  await h.emit("session.inbox.enqueued", { inboxID: "user-1", item: { type: "user", payload: { text: "New request" }, delivery: "queue" } });
  await h.command("task"); await h.emit("session.idle");
  assert.equal(h.continuations().length, 0);
});

test("concurrent resume and idle dispatch at most one pending continuation", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.command("pause");
  await Promise.all([h.command("resume"), h.command("resume"), h.emit("session.idle")]);
  assert.equal(h.continuations().length, 1, "the parked continuation is reused");
  assert.ok(h.sent.some((m) => m.description === "Goal resumed" && m.resume));
});

test("model context prevents parked continuation prompts from reviving a cleared goal", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.command("clear");
  assert.match((await h.modelContext()).at(-1).content[0].text, /cleared/);
});

test("late terminal of a requested pause does not undo an explicit resume", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.start(); await h.command("pause"); await h.command("resume");
  await h.emit("session.execution.interrupted", { reason: "user" });
  assert.equal(h.goal().status, "active");
});

test("budget controls clear a budget, enforce the cap and permit resuming after an increase", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.command("budget 100"); await h.command("budget none");
  assert.equal(h.goal().tokenBudget, null);
  await h.command("budget 100"); await h.start(); await h.settle(); await h.succeed();
  await h.command("budget 1000"); await h.command("resume");
  assert.equal(h.goal().status, "active");
  const capped = await harness(t, { maxGoalTokenBudget: 100 });
  await capped.command("task");
  await assert.rejects(capped.command("budget 101"), /maximum/);
  await assert.rejects(capped.command("budget none"), /configured/);
});

test("session deletion removes persisted goal state", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.emit("session.deleted");
  assert.equal(h.goal(), undefined);
  assert.equal(h.changes.at(-1).status, "");
});

test("budget wrap-up in a separate execution is included in final usage", async (t) => {
  const h = await harness(t, { maxGoalTokenBudget: 100 });
  await h.command("task"); await h.start(); await h.settle(); await h.succeed();
  await h.start(); await h.emit("session.text.delta", { delta: "Budget exhausted; here is the progress." });
  await h.settle(tokens(20, 5)); await h.succeed();
  assert.equal(h.goal().tokensUsed, 135);
  assert.equal(h.goal().status, "budget_limited");
  assert.equal(h.sent.filter((m) => m.metadata.purpose === "budget").length, 1);
});

test("plan mode stops the elapsed-time baseline as well as token charging", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = await harness(t);
  await h.emit("session.agent.selected", { agent: "plan" });
  await h.command("task");
  now += 10000;
  await h.command("status");
  assert.equal(h.goal().timeUsedSeconds, 0);
  await h.start("plan"); now += 10000; await h.settle(); await h.succeed();
  assert.equal(h.goal().timeUsedSeconds, 0);
});

test("authoritative active context allows the blocked audit and supersedes old objectives", async (t) => {
  const h = await harness(t);
  await h.command("task </objective>");
  const text = (await h.modelContext()).at(-1).content[0].text;
  assert.match(text, /current persistent goal is active/);
  assert.match(text, /&lt;\/objective&gt;/);
  assert.match(text, /three consecutive goal turns/);
  assert.doesNotMatch(text, /edited by the user/);
});

test("compaction is charged but title and lifetime usage are excluded", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.start(); await h.settle();
  await h.emit("session.usage.recorded", { source: "compaction", tokens: tokens(20, 5) });
  await h.emit("session.usage.recorded", { source: "title", tokens: tokens(40, 10) });
  await h.succeed();
  assert.equal(h.goal().tokensUsed, 135);
});

test("nonzero shell exit metadata counts as failed execution", async (t) => {
  const h = await harness(t);
  await h.command("task");
  for (let i = 0; i < 3; i++) {
    await h.start(); await h.settle(tokens(), "tool-calls");
    await h.emit("session.tool.input.started", { id: `shell-${i}`, name: "shell" });
    await h.emit("session.tool.called", { id: `shell-${i}` });
    await h.emit("session.tool.success", { id: `shell-${i}`, metadata: { exit: 1 } });
    await h.succeed();
  }
  assert.equal(h.goal().status, "blocked");
});

test("quota errors stop a budget-limited wrap-up without retrying", async (t) => {
  const h = await harness(t, { maxGoalTokenBudget: 100 });
  await h.command("task"); await h.start(); await h.settle(); await h.succeed();
  await h.start();
  await h.emit("session.execution.failed", { error: { type: "APIError", message: "insufficient_quota" } });
  await h.emit("session.idle");
  assert.equal(h.goal().status, "usage_limited");
  assert.equal(h.continuations().length, 1);
});
