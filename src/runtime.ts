import { GoalAccountingState, type TokenUsageSnapshot } from "./accounting.js";
import { GoalStore, ThreadGoalStatus, validateGoalBudget, validateThreadGoalObjective, type ThreadGoal } from "./store.js";
import { budgetLimitPrompt, continuationPrompt, goalStatePrompt, objectiveUpdatedPrompt } from "./steering.js";

export interface GoalPluginOptions {
  enabled: boolean;
  maxGoalTokenBudget: number | null;
  maxContinuationTurns: number;
}

export interface GoalSession {
  synthetic(input: {
    sessionID: string; text: string; description: string; delivery: "steer" | "queue"; resume: boolean;
    metadata: { ocGoal: true; purpose: string; goalId?: string };
  }): Promise<{ id: string }>;
  wait(input: { sessionID: string }): Promise<void>;
  get(input: { sessionID: string }): Promise<{ agent?: string }>;
  interrupt(input: { sessionID: string }): Promise<{ interrupted: boolean }>;
}

interface SessionRuntime {
  accounting: GoalAccountingState;
  turnSeq: number;
  turnId: string | null;
  executing: boolean;
  automatic: boolean;
  continuationPending: boolean;
  waitingForIdle: boolean;
  continuationCount: number;
  stopped: boolean;
  suppressed: boolean;
  agent: string | null;
  hasText: boolean;
  hasTool: boolean;
  usage: TokenUsageSnapshot;
  steps: Map<string, { plan: boolean; settled: boolean }>;
  tools: Map<string, string>;
  inbox: Map<string, { own: boolean; purpose?: string; goalId?: string }>;
  errorKey: string | null;
  errorCount: number;
  controlInterruption: boolean;
}

const zeroUsage = (): TokenUsageSnapshot => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

export class GoalRuntime {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly pending = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    readonly store: GoalStore,
    private readonly session: GoalSession,
    private readonly options: GoalPluginOptions,
    private readonly changed: (sessionID: string) => Promise<void>,
    private readonly log: (message: string) => void,
  ) {}

  /** Commands, tools and events share this queue so accounting snapshots cannot race. */
  async exclusive<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sessionID) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.pending.set(sessionID, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.pending.get(sessionID) === current) this.pending.delete(sessionID);
    }
  }

  private runtime(sessionID: string): SessionRuntime {
    let rt = this.sessions.get(sessionID);
    if (!rt) {
      rt = {
        accounting: new GoalAccountingState(), turnSeq: 0, turnId: null,
        executing: false, automatic: false, continuationPending: false, waitingForIdle: false,
        continuationCount: 0, stopped: false, suppressed: false, agent: null,
        hasText: false, hasTool: false, usage: zeroUsage(),
        steps: new Map(), tools: new Map(), inbox: new Map(), errorKey: null, errorCount: 0, controlInterruption: false,
      };
      this.sessions.set(sessionID, rt);
    }
    return rt;
  }

  private resetRun(rt: SessionRuntime): void {
    rt.stopped = false;
    rt.suppressed = false;
    rt.continuationCount = 0;
    rt.errorKey = null;
    rt.errorCount = 0;
    rt.accounting.resetFailureResponses();
  }

  goalCreated(goal: ThreadGoal): void {
    const rt = this.runtime(goal.threadId);
    this.resetRun(rt);
    if (rt.turnId) rt.accounting.markCurrentTurnGoalActive(goal.goalId);
    else rt.accounting.markIdleGoalActive(goal.goalId);
    if (rt.agent === "plan") rt.accounting.stopWallClock();
  }

  goalUpdated(goal: ThreadGoal): void {
    const rt = this.runtime(goal.threadId);
    rt.stopped = goal.status !== "active";
    // Provider usage can settle after tools; retain the turn's goal until execution ends.
    if (rt.stopped) rt.accounting.stopWallClock();
  }

  private async publish(sessionID: string): Promise<void> {
    try { await this.changed(sessionID); }
    catch (error) { this.log(`status update failed for ${sessionID}: ${String(error)}`); }
  }

  async account(sessionID: string): Promise<ThreadGoal | null> {
    const rt = this.runtime(sessionID);
    const snapshot = rt.turnId ? rt.accounting.progressSnapshot(rt.turnId) : rt.accounting.idleProgressSnapshot();
    if (!snapshot) return this.store.getThreadGoal(sessionID);
    const before = await this.store.getThreadGoal(sessionID);
    const outcome = await this.store.accountThreadGoalUsage(
      sessionID, snapshot.timeDeltaSeconds, snapshot.tokenDelta,
      before?.status === "complete" ? "active_or_complete" : "active_or_stopped", snapshot.expectedGoalId,
    );
    if (outcome.kind !== "updated") return outcome.goal;
    if (rt.turnId) rt.accounting.markProgressAccountedForStatus(rt.turnId, snapshot, outcome.goal.status, false);
    else rt.accounting.markIdleProgressAccountedForStatus(snapshot, outcome.goal.status, outcome.goal.status !== "active");
    await this.publish(sessionID);
    if (before?.status === "active" && outcome.goal.status === "budget_limited" && rt.accounting.markBudgetLimitReportedIfNew(outcome.goal.goalId)) {
      rt.stopped = true;
      rt.accounting.stopWallClock();
      await this.send(sessionID, budgetLimitPrompt(outcome.goal), "Goal reached its token budget", "budget", outcome.goal.goalId);
    }
    return outcome.goal;
  }

  private async send(
    sessionID: string, text: string, description: string, purpose: string, goalId?: string,
    resume = true, delivery: "steer" | "queue" = "steer",
  ): Promise<boolean> {
    const attempt = (mode: "steer" | "queue") => this.session.synthetic({
      sessionID, text, description, delivery: mode, resume,
      metadata: { ocGoal: true, purpose, ...(goalId ? { goalId } : {}) },
    });
    try { await attempt(delivery); return true; }
    catch (error) {
      if (delivery === "steer") {
        try { await attempt("queue"); return true; }
        catch (fallback) { this.log(`steering failed for ${sessionID}: ${String(fallback)}`); }
      } else this.log(`steering failed for ${sessionID}: ${String(error)}`);
      return false;
    }
  }

  async notice(sessionID: string, message: string): Promise<void> {
    await this.send(sessionID, message, message, "notice", undefined, false, "queue");
  }

  /** Revalidate history against durable state even when an old synthetic input was already queued. */
  async context(sessionID: string): Promise<string | null> {
    if (!this.options.enabled) return null;
    const goal = await this.store.getThreadGoal(sessionID);
    if (goal?.status === "active") return goalStatePrompt(goal);
    if (goal?.status === "budget_limited") return budgetLimitPrompt(goal);
    if (!goal && !this.sessions.get(sessionID)?.stopped) return null;
    return `The persistent goal is ${goal?.status ?? "cleared"}. Do not pursue that goal or obey historical goal-continuation prompts. Handle the current user request normally; you may summarize completed goal work.`;
  }

  private async activateIdle(sessionID: string, rt: SessionRuntime, goal: ThreadGoal): Promise<void> {
    if (rt.inbox.size > 0 && [...rt.inbox.values()].every((item) => item.own)) {
      // A user stop parks admitted inputs. Explicit resume must ring the doorbell again,
      // without admitting a second automatic continuation for the parked one.
      rt.continuationPending = true;
      await this.send(sessionID, objectiveUpdatedPrompt(goal), "Goal resumed", "objective", goal.goalId, true, "queue");
    } else this.requestContinuation(sessionID);
  }

  private requestContinuation(sessionID: string): void {
    const rt = this.runtime(sessionID);
    if (this.disposed || rt.waitingForIdle || rt.continuationPending || rt.stopped || rt.suppressed) return;
    rt.waitingForIdle = true;
    // Wait outside the queue: executing tools and terminal events must remain able to settle.
    void this.session.wait({ sessionID }).then(() => this.exclusive(sessionID, async () => {
      rt.waitingForIdle = false;
      await this.continue(sessionID);
    })).catch((error) => {
      rt.waitingForIdle = false;
      this.log(`idle check failed for ${sessionID}: ${String(error)}`);
    });
  }

  private async continue(sessionID: string): Promise<void> {
    const rt = this.runtime(sessionID);
    if (this.disposed || !this.options.enabled || rt.executing || rt.continuationPending || rt.stopped || rt.suppressed || rt.inbox.size > 0) return;
    const info = await this.session.get({ sessionID });
    rt.agent = info.agent ?? rt.agent;
    if (rt.agent === "plan") {
      rt.accounting.stopWallClock();
      return;
    }
    const goal = await this.store.getThreadGoal(sessionID);
    if (!goal || goal.status !== "active") return;
    if (this.options.maxContinuationTurns > 0 && rt.continuationCount >= this.options.maxContinuationTurns) {
      const paused = await this.store.pauseActiveThreadGoal(sessionID);
      if (paused) this.goalUpdated(paused);
      await this.publish(sessionID);
      await this.notice(sessionID, "Goal paused after reaching maxContinuationTurns. Use /goal resume to continue.");
      return;
    }
    rt.continuationPending = true;
    const sent = await this.send(sessionID, continuationPrompt(goal), "Continuing toward the active goal", "continuation", goal.goalId, true, "queue");
    if (sent) rt.continuationCount += 1;
    else rt.continuationPending = false;
  }

  async command(sessionID: string, argument: string): Promise<string> {
    return this.exclusive(sessionID, async () => {
      if (!this.options.enabled) return "Goal plugin is disabled.";
      const arg = argument.trim();
      const rt = this.runtime(sessionID);
      if (!arg || arg === "status") {
        const goal = await this.account(sessionID);
        return goal
          ? `Goal status: ${goal.status}\nObjective: ${goal.objective}\nTokens: ${goal.tokensUsed}${goal.tokenBudget !== null ? ` / ${goal.tokenBudget}` : ""}\nTime: ${goal.timeUsedSeconds}s`
          : "No goal set for this session.";
      }
      if (arg === "pause" || arg === "clear") {
        await this.account(sessionID);
        const goal = arg === "pause" ? await this.store.pauseActiveThreadGoal(sessionID) : await this.store.deleteThreadGoal(sessionID);
        if (arg === "pause" && !goal) return "No active goal to pause.";
        rt.stopped = true;
        rt.continuationPending = false;
        rt.accounting.stopWallClock();
        if (arg === "clear") rt.accounting.clearActiveGoal();
        rt.controlInterruption = (await this.session.interrupt({ sessionID })).interrupted;
        await this.publish(sessionID);
        return arg === "clear" ? "Goal cleared." : "Goal paused.";
      }
      if (arg === "resume") {
        await this.account(sessionID);
        const goal = await this.store.updateThreadGoal(sessionID, { status: "active" });
        if (!goal || goal.status !== "active") return goal ? `Goal is ${goal.status}; cannot resume.` : "No goal to resume.";
        this.resetRun(rt);
        if (rt.turnId) rt.accounting.markCurrentTurnGoalActive(goal.goalId);
        else rt.accounting.markIdleGoalActive(goal.goalId);
        if (rt.agent === "plan") rt.accounting.stopWallClock();
        await this.publish(sessionID);
        if (rt.executing) await this.send(sessionID, continuationPrompt(goal), "Goal resumed", "objective", goal.goalId);
        else await this.activateIdle(sessionID, rt, goal);
        return "Goal resumed.";
      }
      if (arg.startsWith("budget ")) {
        const value = arg.slice(7).trim();
        const budget = value === "none" ? null : /^\d+$/.test(value) ? Number(value) : NaN;
        const error = validateGoalBudget(budget, this.options.maxGoalTokenBudget);
        if (error) throw new Error(error);
        if (budget === null && this.options.maxGoalTokenBudget !== null) throw new Error("cannot remove the configured maximum goal token budget");
        await this.account(sessionID);
        const goal = await this.store.updateThreadGoal(sessionID, { tokenBudget: budget });
        if (!goal) return "No goal to update.";
        this.goalUpdated(goal);
        await this.publish(sessionID);
        if (goal.status === "budget_limited" && rt.accounting.markBudgetLimitReportedIfNew(goal.goalId)) {
          await this.send(sessionID, budgetLimitPrompt(goal), "Goal reached its token budget", "budget", goal.goalId);
        }
        return `Goal token budget: ${goal.tokenBudget ?? "none"}.`;
      }
      const error = validateThreadGoalObjective(arg);
      if (error) throw new Error(error);
      await this.account(sessionID);
      const existing = await this.store.getThreadGoal(sessionID);
      const same = existing?.objective === arg && !ThreadGoalStatus.isTerminal(existing.status);
      const goal = same
        ? (await this.store.updateThreadGoal(sessionID, { status: "active" }))!
        : await this.store.replaceThreadGoal(sessionID, arg, "active", this.options.maxGoalTokenBudget);
      if (!same || existing.status !== "active") this.resetRun(rt);
      rt.stopped = goal.status !== "active";
      if (rt.turnId) rt.accounting.markCurrentTurnGoalActive(goal.goalId);
      else rt.accounting.markIdleGoalActive(goal.goalId);
      if (rt.agent === "plan") rt.accounting.stopWallClock();
      await this.publish(sessionID);
      if (rt.executing) await this.send(sessionID, objectiveUpdatedPrompt(goal), "Goal objective updated", "objective", goal.goalId);
      else await this.activateIdle(sessionID, rt, goal);
      return `Goal set (${goal.status}): ${goal.objective}`;
    });
  }

  private async start(sessionID: string, rt: SessionRuntime): Promise<void> {
    if (rt.turnId) rt.accounting.finishTurn(rt.turnId);
    rt.executing = true;
    rt.turnId = `turn-${++rt.turnSeq}`;
    rt.automatic = rt.continuationPending;
    rt.continuationPending = false;
    rt.hasText = false;
    rt.hasTool = false;
    rt.usage = zeroUsage();
    rt.steps.clear();
    rt.tools.clear();
    rt.accounting.startTurn(rt.turnId, true);
    const goal = await this.store.getThreadGoal(sessionID);
    if (goal?.status === "active") {
      rt.accounting.markTurnGoalActive(rt.turnId, goal.goalId);
      if (rt.automatic) rt.accounting.markGoalContinuation(rt.turnId);
      if (rt.agent === "plan") rt.accounting.stopWallClock();
    }
  }

  private async recordUsage(sessionID: string, rt: SessionRuntime, tokens: TokenUsageSnapshot): Promise<void> {
    rt.usage = {
      input: rt.usage.input + tokens.input, output: rt.usage.output + tokens.output,
      reasoning: (rt.usage.reasoning ?? 0) + (tokens.reasoning ?? 0),
      cache: { read: rt.usage.cache.read + tokens.cache.read, write: rt.usage.cache.write + tokens.cache.write },
    };
    if (rt.turnId) rt.accounting.recordTokenUsage(rt.turnId, rt.usage);
    await this.account(sessionID);
  }

  private async finish(sessionID: string, rt: SessionRuntime, type: string, data: Record<string, unknown>): Promise<void> {
    await this.account(sessionID);
    let goal = await this.store.getThreadGoal(sessionID);
    if (type === "session.execution.interrupted") {
      const controlled = rt.controlInterruption;
      rt.controlInterruption = false;
      if (!controlled && data.reason !== "shutdown" && data.reason !== "superseded") {
        const paused = await this.store.pauseActiveThreadGoal(sessionID);
        if (paused) goal = paused;
        rt.stopped = true;
      }
    } else if (type === "session.execution.failed" && goal && (goal.status === "active" || goal.status === "budget_limited")) {
      rt.accounting.resetFailureResponses();
      const error = data.error as { type?: string; message?: string; status?: number } | undefined;
      const key = `${error?.type ?? ""}:${error?.status ?? ""}:${error?.message ?? ""}`;
      if (/usage.?limit|quota|insufficient_quota/i.test(key)) goal = await this.store.usageLimitActiveThreadGoal(sessionID);
      else if (goal.status === "active") {
        rt.errorCount = rt.errorKey === key ? rt.errorCount + 1 : 1;
        rt.errorKey = key;
        if (rt.errorCount >= 3) goal = await this.store.updateThreadGoal(sessionID, { status: "blocked", expectedGoalId: goal.goalId });
      }
    } else if (type === "session.execution.succeeded") {
      rt.errorCount = 0;
      rt.errorKey = null;
      if (rt.turnId && goal?.status === "active" && rt.agent !== "plan") {
        rt.accounting.recordActivity(rt.turnId, false, true);
        const blocked = rt.accounting.executionFailureGoal(rt.turnId) ?? rt.accounting.emptyResponseGoal(rt.turnId);
        if (blocked) goal = await this.store.updateThreadGoal(sessionID, { status: "blocked", expectedGoalId: blocked });
        // Empty responses get a bounded retry. Text-only automatic turns suppress continuation.
        if (rt.automatic && rt.hasText && !rt.hasTool) rt.suppressed = true;
      }
    }
    rt.executing = false;
    if (rt.turnId) rt.accounting.finishTurn(rt.turnId);
    rt.turnId = null;
    rt.automatic = false;
    rt.steps.clear();
    rt.tools.clear();
    rt.stopped = rt.stopped || (goal !== null && goal.status !== "active");
    if (rt.stopped || rt.suppressed || rt.agent === "plan") rt.accounting.stopWallClock();
    await this.publish(sessionID);
    // Terminal events are durable; session.idle is a separate live notification that
    // may be missed after a provider failure. wait() still enforces the idle boundary.
    this.requestContinuation(sessionID);
  }

  async event(event: { type: string; id?: string; data?: Record<string, unknown> }): Promise<void> {
    const data = event.data ?? {};
    const sessionID = data.sessionID;
    if (this.disposed || !this.options.enabled || typeof sessionID !== "string") return;
    return this.exclusive(sessionID, async () => {
      const rt = this.runtime(sessionID);
      switch (event.type) {
        case "session.deleted":
          await this.store.deleteThreadGoal(sessionID);
          this.sessions.delete(sessionID);
          await this.publish(sessionID);
          return;
        case "session.agent.selected":
          rt.agent = String(data.agent);
          if (rt.agent === "plan") rt.accounting.stopWallClock();
          return;
        case "session.inbox.enqueued": {
          const item = data.item as { type: string; payload?: { metadata?: { ocGoal?: boolean; purpose?: string; goalId?: string } } };
          const meta = item.payload?.metadata;
          if (meta?.ocGoal && meta.purpose === "notice") return;
          rt.inbox.set(String(data.inboxID), { own: meta?.ocGoal === true, purpose: meta?.purpose, goalId: meta?.goalId });
          if (item.type === "user") { rt.suppressed = false; rt.accounting.resetEmptyResponses(); }
          return;
        }
        case "session.inbox.delivered":
        case "session.inbox.cancelled": {
          const item = rt.inbox.get(String(data.inboxID));
          rt.inbox.delete(String(data.inboxID));
          if (event.type === "session.inbox.delivered" && item && rt.turnId) {
            if (item.purpose === "continuation") { rt.automatic = true; rt.accounting.markGoalContinuation(rt.turnId); }
            else if (item.own && item.purpose === "budget") {
              const goal = await this.store.getThreadGoal(sessionID);
              if (goal && goal.goalId === item.goalId && goal.status === "budget_limited") {
                rt.accounting.markCurrentTurnGoalActive(goal.goalId);
                rt.accounting.stopWallClock();
              }
            }
            else if (!item.own) rt.automatic = false;
          }
          if (event.type === "session.inbox.cancelled" && item?.purpose === "continuation") rt.continuationPending = false;
          if (!rt.executing && rt.inbox.size === 0) this.requestContinuation(sessionID);
          return;
        }
        case "session.execution.started":
          await this.start(sessionID, rt);
          return;
        case "session.step.started": {
          if (!rt.turnId) await this.start(sessionID, rt);
          rt.agent = String(data.agent ?? rt.agent ?? "build");
          rt.steps.set(String(data.assistantMessageID), { plan: rt.agent === "plan", settled: false });
          if (rt.agent === "plan") rt.accounting.stopWallClock();
          else {
            const goal = await this.store.getThreadGoal(sessionID);
            if (goal?.status === "active") rt.accounting.markTurnGoalActive(rt.turnId!, goal.goalId);
          }
          return;
        }
        case "session.step.ended":
        case "session.step.failed": {
          const step = rt.steps.get(String(data.assistantMessageID));
          if (!step || step.settled) return;
          step.settled = true;
          // These are settled per-request facts; session.usage.updated contains lifetime totals.
          const tokens = data.tokens as TokenUsageSnapshot | undefined;
          if (tokens && !step.plan) await this.recordUsage(sessionID, rt, tokens);
          return;
        }
        case "session.usage.recorded":
          if (data.source === "compaction" && rt.turnId && rt.agent !== "plan") await this.recordUsage(sessionID, rt, data.tokens as TokenUsageSnapshot);
          return;
        case "session.tool.input.started":
          rt.tools.set(String(data.id), String(data.name));
          return;
        case "session.tool.called":
          if (rt.agent !== "plan") rt.hasTool = true;
          return;
        case "session.tool.success":
        case "session.tool.failed": {
          if (!rt.turnId || rt.agent === "plan") return;
          const tool = rt.tools.get(String(data.id)) ?? "";
          const meta = data.metadata as { exit?: number; exitCode?: number } | undefined;
          rt.accounting.recordToolOutcome(rt.turnId, tool, event.type === "session.tool.failed"
            ? { kind: "failed", handlerExecuted: data.executed === true }
            : { kind: "completed", success: (meta?.exit ?? meta?.exitCode ?? 0) === 0 });
          return;
        }
        case "session.text.delta":
        case "session.text.ended":
        case "session.reasoning.delta":
        case "session.reasoning.ended": {
          if (!rt.turnId || rt.agent === "plan") return;
          const text = String(data.text ?? data.delta ?? "");
          const nonempty = text.trim().length > 0;
          rt.hasText ||= nonempty;
          rt.accounting.recordActivity(rt.turnId, nonempty, false);
          return;
        }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          await this.finish(sessionID, rt, event.type, data);
          return;
        case "session.idle":
          await this.account(sessionID);
          this.requestContinuation(sessionID);
          return;
      }
    });
  }

  async tick(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionID) => this.exclusive(sessionID, async () => {
      if (!this.disposed) await this.account(sessionID);
    })));
  }

  dispose(): void { this.disposed = true; }
}
