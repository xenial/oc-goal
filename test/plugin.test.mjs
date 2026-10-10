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

test("a truncated OpenAI stream resumes without a separate idle event", async (t) => {
  const h = await harness(t);
  await h.command("task"); const id = await h.start();
  await h.emit("session.text.delta", { delta: "Partial response before the stream failed" });
  const error = { type: "ProviderError", message: "OpenAI Chat stream ended without finish_reason" };
  await h.emit("session.step.failed", { assistantMessageID: id, tokens: tokens(), error });
  await h.emit("session.execution.failed", { error });
  assert.equal(h.goal().status, "active");
  assert.equal(h.goal().tokensUsed, 110);
  assert.equal(h.continuations().length, 2);
  await h.emit("session.idle");
  assert.equal(h.continuations().length, 2, "a late idle event cannot enqueue another continuation");
});

test("successful goal work continues without a separate idle event", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.start(); await h.settle(); await h.shell(true);
  await h.emit("session.execution.succeeded");
  assert.equal(h.continuations().length, 2);
});

test("failure recovery waits for idle and respects input arriving before it", async (t) => {
  const h = await harness(t);
  await h.command("task"); await h.start();
  let idle;
  h.context.session.wait = () => new Promise((resolve) => { idle = resolve; });
  await h.emit("session.execution.failed", { error: { type: "ProviderError", message: "OpenAI Chat stream ended without finish_reason" } });
  assert.equal(h.continuations().length, 1);
  assert.equal(typeof idle, "function");
  await h.emit("session.inbox.enqueued", { inboxID: "user-1", item: { type: "user", payload: { text: "New request" }, delivery: "queue" } });
  idle(); await flush();
  assert.equal(h.continuations().length, 1);
});

test("repeated stream failures block and publish the status without idle events", async (t) => {
  const h = await harness(t);
  await h.command("task");
  for (let i = 0; i < 3; i++) {
    await h.start();
    await h.emit("session.execution.failed", { error: { type: "ProviderError", message: "OpenAI Chat stream ended without finish_reason" } });
    assert.equal(h.goal().status, i === 2 ? "blocked" : "active");
  }
  assert.equal(h.continuations().length, 3);
  assert.equal(h.changes.at(-1).goalStatus, "blocked");
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
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = await harness(t);
  await h.emit("session.agent.selected", { agent: "plan" });
  await h.command("task");
  now += 10000;
  await h.command("status");
  assert.equal(h.goal().timeUsedSeconds, 0);
  await h.start("plan"); now += 10000; await h.settle(); await h.succeed();
  assert.equal(h.goal().timeUsedSeconds, 0);
});

test("elapsed time follows real duration despite system clock jumps and frequent updates", async (t) => {
  let elapsed = 0, wallTime = Date.now();
  t.mock.method(performance, "now", () => elapsed);
  t.mock.method(Date, "now", () => wallTime);
  const h = await harness(t);
  await h.command("task"); await h.start();
  for (let i = 0; i < 30; i++) {
    elapsed += 100;
    wallTime += 60_000;
    if (i) await h.step();
    await h.settle(tokens(1, 1), "tool-calls"); await h.shell(true);
    await Promise.all([h.command("status"), h.tool("get_goal"), h.emit("session.idle")]);
    assert.equal(h.goal().timeUsedSeconds, Math.floor(elapsed / 1000));
  }
  await h.emit("session.execution.succeeded");
  assert.equal(h.goal().timeUsedSeconds, 3);
  assert.equal(h.goal().tokensUsed, 60);
  assert.match((await h.get()).status, / 3s$/);
});

test("queued timer ticks account each elapsed second once", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  await h.command("task"); await h.start();
  now = 30_000;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(h.goal().timeUsedSeconds, 30);
  now += 1000;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.goal().timeUsedSeconds, 31);
});

test("ten loaded locations account a global session event only once", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const db = new Map(), location = { directory: "C:/test/owner" };
  const owner = await harness(t, {}, { db, location });
  const locations = [owner];
  for (let i = 0; i < 9; i++) {
    locations.push(await harness(t, {}, { db, location: { directory: `C:/test/other-${i}` }, sessionLocation: location }));
  }
  await owner.command("task"); await owner.start();
  for (const h of locations.slice(1)) await h.emit("session.execution.started");
  for (const h of locations) await h.emit("session.step.started", { assistantMessageID: "shared-step", agent: "build" });
  now = 1000;
  for (const h of locations) await h.emit("session.idle");
  assert.equal(owner.goal().timeUsedSeconds, 1, "each loaded location must not add its own second");
  for (const h of locations) await h.emit("session.step.ended", { assistantMessageID: "shared-step", tokens: tokens(), finish: "stop" });
  assert.equal(owner.goal().tokensUsed, 110);
  for (const h of locations) await h.emit("session.execution.succeeded");
  assert.equal(locations.reduce((n, h) => n + h.continuations().length, 0), 2);
  assert.ok(locations.slice(1).every((h) => h.changes.length === 0));
});

test("events without a location resolve session ownership before accounting", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const db = new Map(), location = { directory: "C:/test/owner" };
  const owner = await harness(t, {}, { db, location });
  const other = await harness(t, {}, { db, location: { directory: "C:/test/other" }, sessionLocation: location });
  await owner.command("task"); await owner.start();
  await other.emit("session.execution.started", {}, "s", null);
  now = 1000;
  await owner.emit("session.idle", {}, "s", null);
  await other.emit("session.idle", {}, "s", null);
  assert.equal(owner.goal().timeUsedSeconds, 1);
  await other.emit("session.execution.interrupted", { reason: "user" }, "s", null);
  await other.emit("session.deleted", {}, "s", null);
  assert.equal(owner.goal().status, "active", "a foreign instance cannot pause or delete a goal");
  assert.equal(other.changes.length, 0);
});

test("Windows location ownership accepts equivalent path spelling", async (t) => {
  const h = await harness(t, {}, { location: { directory: "C:\\TEST\\PROJECT\\" } });
  await h.command("task"); await h.start();
  await h.emit("session.execution.interrupted", { reason: "user" }, "s", { directory: "c:/test/project" });
  assert.equal(h.goal().status, "paused");
});

test("workspace identity distinguishes instances with the same directory", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const db = new Map(), location = { directory: "C:/test/project", workspaceID: "workspace-owner" };
  const owner = await harness(t, {}, { db, location });
  const other = await harness(t, {}, { db, location: { ...location, workspaceID: "workspace-other" }, sessionLocation: location });
  await owner.command("task"); await owner.start();
  await other.emit("session.execution.started");
  now = 1000;
  await owner.emit("session.idle"); await other.emit("session.idle");
  assert.equal(owner.goal().timeUsedSeconds, 1);
  await other.emit("session.deleted");
  assert.equal(owner.goal().status, "active");
});

test("overlapping reloads keep one timer and preserve unsettled execution usage", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const db = new Map(), location = { directory: "C:/test/reload" };
  const original = await harness(t, {}, { db, location });
  await original.command("task"); await original.start();
  const instances = [original];
  for (let i = 0; i < 9; i++) {
    now += 1000;
    t.mock.timers.tick(1000); await flush();
    assert.equal(original.goal().timeUsedSeconds, i + 1);
    // A fresh module evaluation models OpenCode invalidating the import cache.
    const { default: reloaded } = await import(`../dist/index.js?reload-test=${i}`);
    instances.push(await harness(t, {}, { db, location, plugin: reloaded }));
  }
  assert.ok(instances.slice(0, -1).every((h) => h.closed()));
  const current = instances.at(-1);
  now += 1000;
  t.mock.timers.tick(1000); await flush();
  assert.equal(current.goal().timeUsedSeconds, 10);
  await current.emit("session.step.ended", { assistantMessageID: "step-2", tokens: tokens(), finish: "stop" });
  assert.equal(current.goal().tokensUsed, 110, "the request started before reload must still settle");
  for (const h of instances.slice(0, -1)) await h.cleanup();
  now += 1000;
  t.mock.timers.tick(1000); await flush();
  assert.equal(current.goal().timeUsedSeconds, 11, "late finalizers must not retire the replacement");
  await current.emit("session.execution.failed", { error: { message: "OpenAI Chat stream ended without finish_reason" } });
  assert.equal(current.continuations().length, 1);
});

test("an overlapping setup that finishes late cannot start another timer", async (t) => {
  let now = 0, registered, finishRegistration;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const db = new Map(), location = { directory: "C:/test/overlapping-setup" };
  const ready = new Promise((resolve) => { registered = resolve; });
  const gate = new Promise((resolve) => { finishRegistration = resolve; });
  const pending = harness(t, {}, { db, location, registerTools: () => { registered(); return gate; } });
  await ready;
  const current = await harness(t, {}, { db, location });
  await current.command("task"); await current.start();
  finishRegistration();
  const stale = await pending;
  now = 5000;
  t.mock.timers.tick(5000); await flush();
  assert.equal(current.goal().timeUsedSeconds, 5);
  assert.equal(stale.changes.length, 0);
  await stale.cleanup(); await stale.cleanup();
  now = 6000;
  t.mock.timers.tick(1000); await flush();
  assert.equal(current.goal().timeUsedSeconds, 6);
});

test("a disabled replacement stops the prior enabled instance", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const db = new Map(), location = { directory: "C:/test/disabled-reload" };
  const original = await harness(t, {}, { db, location });
  await original.command("task"); await original.start();
  await harness(t, { enabled: false }, { db, location });
  now = 5000;
  t.mock.timers.tick(5000); await flush();
  assert.ok(original.closed());
  assert.equal(original.goal().timeUsedSeconds, 0);
  const enabled = await harness(t, {}, { db, location });
  now = 6000;
  t.mock.timers.tick(1000); await flush();
  assert.equal(enabled.goal().timeUsedSeconds, 0, "disabled time must not be charged on re-enable");
  await enabled.start();
  now = 7000;
  t.mock.timers.tick(1000); await flush();
  assert.equal(enabled.goal().timeUsedSeconds, 1);
});

test("reload recovers a pending idle check without letting the old waiter dispatch", async (t) => {
  let oldReady, newReady;
  const oldIdle = new Promise((resolve) => { oldReady = resolve; });
  const newIdle = new Promise((resolve) => { newReady = resolve; });
  const db = new Map(), location = { directory: "C:/test/reload-idle-check" };
  const original = await harness(t, {}, { db, location, wait: () => oldIdle });
  await original.command("task");
  const current = await harness(t, {}, { db, location, wait: () => newIdle });
  oldReady(); await flush();
  assert.equal(original.continuations().length, 0);
  assert.equal(current.continuations().length, 0);
  newReady(); await flush();
  assert.equal(current.continuations().length, 1);
});

test("a timer write already in flight during reload is accounted once", async (t) => {
  let now = 0, reading, finishRead;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const db = new Map(), location = { directory: "C:/test/reload-in-flight" };
  const original = await harness(t, {}, { db, location });
  await original.command("task"); await original.start();
  const get = original.context.storage.get;
  const ready = new Promise((resolve) => { reading = resolve; });
  const gate = new Promise((resolve) => { finishRead = resolve; });
  let delay = true;
  original.context.storage.get = async (key) => {
    if (delay) { delay = false; reading(); await gate; }
    return get(key);
  };
  now = 1000;
  t.mock.timers.tick(1000); await ready;
  const current = await harness(t, {}, { db, location });
  finishRead(); await flush();
  assert.equal(current.goal().timeUsedSeconds, 1);
  now = 2000;
  t.mock.timers.tick(1000); await flush();
  assert.equal(current.goal().timeUsedSeconds, 2);
});

test("a failure already in flight at takeover still resumes through the replacement", async (t) => {
  let now = 0, reading, finishRead;
  t.mock.method(performance, "now", () => now);
  const db = new Map(), location = { directory: "C:/test/reload-terminal" };
  const original = await harness(t, {}, { db, location });
  await original.command("task"); await original.start();
  const get = original.context.storage.get;
  const ready = new Promise((resolve) => { reading = resolve; });
  const gate = new Promise((resolve) => { finishRead = resolve; });
  let delay = true;
  original.context.storage.get = async (key) => {
    if (delay) { delay = false; reading(); await gate; }
    return get(key);
  };
  now = 1000;
  const failure = original.emit("session.execution.failed", { error: { message: "OpenAI Chat stream ended without finish_reason" } });
  await ready;
  const current = await harness(t, {}, { db, location });
  finishRead(); await failure; await flush();
  assert.equal(current.goal().timeUsedSeconds, 1);
  assert.equal(original.continuations().length, 1, "only the original initial continuation was sent");
  assert.equal(current.continuations().length, 1, "the replacement recovers the terminal boundary");
});

test("paused time is excluded when a goal resumes", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = await harness(t);
  await h.command("task"); await h.start();
  now += 2500;
  await h.command("pause");
  await h.emit("session.execution.interrupted", { reason: "user" });
  assert.equal(h.goal().timeUsedSeconds, 2);
  now += 120_000;
  await h.command("status");
  assert.equal(h.goal().timeUsedSeconds, 2);
  await h.command("resume"); await h.start();
  now += 2000;
  await h.command("status");
  assert.equal(h.goal().timeUsedSeconds, 4);
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
