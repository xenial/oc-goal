/**
 * Per-session accounting state, ported from codex `ext/goal/src/accounting.rs`.
 *
 * Tracks, per goal turn: token baseline / delta, wall-clock baseline, tool
 * activity, empty-response and failed-execution streaks. Pure logic; the
 * plugin wires it to opencode events and the `GoalStore`.
 */

import { goalTokenDeltaForUsage } from "./store.js";

export interface TokenUsageSnapshot {
  input: number;
  output: number;
  reasoning?: number;
  cache: { read: number; write: number };
}

export type ToolOutcome =
  | { kind: "completed"; success: boolean }
  | { kind: "failed"; handlerExecuted: boolean }
  | { kind: "blocked" }
  | { kind: "aborted" };

export const EXEC_TOOL_NAMES = new Set(["exec", "bash", "shell", "execute_command", "run_command"]);

const EMPTY_THRESHOLD = 3;
const EXEC_FAILURE_THRESHOLD = 3;

export interface GoalProgressSnapshot {
  expectedGoalId: string;
  timeDeltaSeconds: number;
  tokenDelta: number;
  usage?: TokenUsageSnapshot;
}

interface TurnAccounting {
  /** Cumulative token usage at the last accounting point. */
  lastAccounted: TokenUsageSnapshot;
  /** Latest observed cumulative usage. */
  current: TokenUsageSnapshot;
  activeGoalId: string | null;
  accountTokens: boolean;
  failedExecution: boolean;
  successfulTool: boolean;
  emptyFinal: boolean;
  hasActivity: boolean;
  failureChecked: boolean;
}

function zeroUsage(): TokenUsageSnapshot {
  return { input: 0, output: 0, cache: { read: 0, write: 0 } };
}

function tokenDelta(last: TokenUsageSnapshot, current: TokenUsageSnapshot): number {
  const delta = {
    input: Math.max(0, current.input - last.input),
    output: Math.max(0, current.output - last.output),
    reasoning: Math.max(0, (current.reasoning ?? 0) - (last.reasoning ?? 0)),
    cache: {
      read: Math.max(0, current.cache.read - last.cache.read),
      write: Math.max(0, current.cache.write - last.cache.write),
    },
  };
  return goalTokenDeltaForUsage(delta);
}

export class GoalAccountingState {
  private currentTurnId: string | null = null;
  private interruptedTurnId: string | null = null;
  private readonly turns = new Map<string, TurnAccounting>();
  /** Monotonic elapsed-time baseline; system clock adjustments must not affect usage. */
  private wallClockBaselineMs = performance.now();
  private wallClockActiveGoalId: string | null = null;
  private budgetLimitReportedGoalId: string | null = null;
  private executionFailureGoalId: string | null = null;
  private consecutiveExecutionFailureTurns = 0;
  private automaticGoalTurnId: string | null = null;
  private consecutiveEmptyTurns = 0;

  startTurn(turnId: string, accountTokens: boolean, baseline?: TokenUsageSnapshot): void {
    if (this.currentTurnId !== null) this.turns.delete(this.currentTurnId);
    if (this.interruptedTurnId !== null) {
      this.turns.delete(this.interruptedTurnId);
      this.interruptedTurnId = null;
      this.consecutiveEmptyTurns = 0;
    }
    this.currentTurnId = turnId;
    const base = baseline ?? zeroUsage();
    this.turns.set(turnId, {
      lastAccounted: { ...base, cache: { ...base.cache } },
      current: { ...base, cache: { ...base.cache } },
      activeGoalId: null,
      accountTokens,
      failedExecution: false,
      successfulTool: false,
      emptyFinal: false,
      hasActivity: false,
      failureChecked: false,
    });
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  getInterruptedTurnId(): string | null {
    return this.interruptedTurnId;
  }

  recordToolOutcome(turnId: string, toolName: string, outcome: ToolOutcome): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    if (!toolAttemptCountsForGoalProgress(outcome)) return;
    this.consecutiveEmptyTurns = 0;
    turn.hasActivity = true;
    if (turn.activeGoalId === null) return;

    if (outcome.kind === "completed" && outcome.success) {
      turn.successfulTool = true;
      this.executionFailureGoalId = null;
      this.consecutiveExecutionFailureTurns = 0;
    } else if (
      ((outcome.kind === "failed" && outcome.handlerExecuted) ||
        (outcome.kind === "completed" && !outcome.success)) &&
      EXEC_TOOL_NAMES.has(toolName)
    ) {
      turn.failedExecution = true;
    }
  }

  /** Returns a goal id when the exec-failure threshold is reached. */
  executionFailureGoal(turnId: string): string | null {
    const turn = this.turns.get(turnId);
    if (!turn || turn.failureChecked) return null;
    turn.failureChecked = true;
    const goalId = turn.activeGoalId;
    if (goalId === null) return null;
    if (turn.successfulTool) return null;
    if (!turn.failedExecution) {
      this.executionFailureGoalId = null;
      this.consecutiveExecutionFailureTurns = 0;
      return null;
    }

    if (this.executionFailureGoalId !== goalId) {
      this.executionFailureGoalId = goalId;
      this.consecutiveExecutionFailureTurns = 0;
    }
    this.consecutiveExecutionFailureTurns = Math.min(255, this.consecutiveExecutionFailureTurns + 1);
    return this.consecutiveExecutionFailureTurns >= EXEC_FAILURE_THRESHOLD ? goalId : null;
  }

  /** Mark a turn as having produced activity (text/reasoning/tool). */
  recordActivity(turnId: string, hasText: boolean, isFinal: boolean): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.hasActivity = turn.hasActivity || hasText;
    if (!hasText && isFinal) turn.emptyFinal = true;
    if (turn.hasActivity) this.consecutiveEmptyTurns = 0;
  }

  markGoalContinuation(turnId: string): void {
    this.automaticGoalTurnId = turnId;
  }

  resetEmptyResponses(): void {
    this.automaticGoalTurnId = null;
    this.consecutiveEmptyTurns = 0;
  }

  resetFailureResponses(): void {
    this.resetEmptyResponses();
    this.executionFailureGoalId = null;
    this.consecutiveExecutionFailureTurns = 0;
  }

  /** Stop elapsed-time charging, retaining in-flight token attribution. */
  stopWallClock(): void {
    this.clearWallClockActive();
  }

  /** Returns a goal id when the empty-response threshold is reached. */
  emptyResponseGoal(turnId: string): string | null {
    const interrupted = this.interruptedTurnId === turnId;
    if (interrupted) this.interruptedTurnId = null;
    const automatic = this.automaticGoalTurnId === turnId;
    const turn = this.turns.get(turnId);
    if (!turn) return null;
    const goalId = turn.activeGoalId;
    if (goalId === null) return null;
    const empty = automatic && !turn.hasActivity && (turn.emptyFinal || interrupted);
    turn.emptyFinal = false;
    if (!empty) {
      this.consecutiveEmptyTurns = 0;
      return null;
    }
    this.consecutiveEmptyTurns = Math.min(255, this.consecutiveEmptyTurns + 1);
    return this.consecutiveEmptyTurns >= EMPTY_THRESHOLD ? goalId : null;
  }

  currentActiveGoalIdForTurn(turnId: string): string | null {
    if (this.currentTurnId !== turnId && this.interruptedTurnId !== turnId) return null;
    const turn = this.turns.get(turnId);
    if (!turn || !turn.accountTokens) return null;
    return turn.activeGoalId;
  }

  recordTokenUsage(turnId: string, total: TokenUsageSnapshot): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.current = { ...total, cache: { ...total.cache } };
  }

  markTurnGoalActive(turnId: string, goalId: string): void {
    if (this.budgetLimitReportedGoalId !== goalId) this.budgetLimitReportedGoalId = null;
    const turn = this.turns.get(turnId);
    if (turn) {
      turn.activeGoalId = goalId;
      if (this.currentTurnId === turnId) {
        if (this.wallClockActiveGoalId !== goalId) this.consecutiveEmptyTurns = 0;
        this.markWallClockActive(goalId);
      }
    }
  }

  /** Mark the current turn's goal active; returns the turn id if any. */
  markCurrentTurnGoalActive(goalId: string): string | null {
    const turnId = this.currentTurnId;
    if (turnId === null) return null;
    if (this.budgetLimitReportedGoalId !== goalId) this.budgetLimitReportedGoalId = null;
    const goalChanged = this.wallClockActiveGoalId !== goalId;
    const turn = this.turns.get(turnId);
    if (!turn) return null;
    if (turn.activeGoalId !== goalId) {
      turn.failedExecution = false;
      turn.successfulTool = false;
    }
    turn.activeGoalId = goalId;
    if (goalChanged) {
      turn.lastAccounted = { ...turn.current, cache: { ...turn.current.cache } };
      this.automaticGoalTurnId = null;
      this.consecutiveEmptyTurns = 0;
    }
    this.markWallClockActive(goalId);
    return turnId;
  }

  markIdleGoalActive(goalId: string): void {
    if (this.budgetLimitReportedGoalId !== goalId) this.budgetLimitReportedGoalId = null;
    if (this.wallClockActiveGoalId !== goalId) this.consecutiveEmptyTurns = 0;
    this.markWallClockActive(goalId);
  }

  clearCurrentTurnGoal(): string | null {
    const turnId = this.currentTurnId;
    if (turnId === null) return null;
    const turn = this.turns.get(turnId);
    if (turn) turn.activeGoalId = null;
    this.clearWallClockActive();
    this.budgetLimitReportedGoalId = null;
    this.executionFailureGoalId = null;
    this.consecutiveExecutionFailureTurns = 0;
    this.automaticGoalTurnId = null;
    this.consecutiveEmptyTurns = 0;
    return turnId;
  }

  clearActiveGoal(): void {
    const turnId = this.currentTurnId;
    if (turnId !== null) {
      const turn = this.turns.get(turnId);
      if (turn) turn.activeGoalId = null;
    }
    this.clearWallClockActive();
    this.budgetLimitReportedGoalId = null;
    this.executionFailureGoalId = null;
    this.consecutiveExecutionFailureTurns = 0;
    this.automaticGoalTurnId = null;
    this.consecutiveEmptyTurns = 0;
  }

  /** Snapshot the unaccounted time/token deltas for a turn, or null. */
  progressSnapshot(turnId: string): GoalProgressSnapshot | null {
    const turn = this.turns.get(turnId);
    if (!turn || !turn.accountTokens) return null;
    const goalId = turn.activeGoalId;
    if (goalId === null) return null;
    const tok = tokenDelta(turn.lastAccounted, turn.current);
    const time =
      this.wallClockActiveGoalId === goalId ? this.wallClockDeltaSeconds() : 0;
    if (time === 0 && tok <= 0) return null;
    return {
      expectedGoalId: goalId,
      timeDeltaSeconds: time,
      tokenDelta: tok,
      usage: { ...turn.current, cache: { ...turn.current.cache } },
    };
  }

  /** Snapshot idle progress (wall clock while active, no in-turn tokens). */
  idleProgressSnapshot(): GoalProgressSnapshot | null {
    const goalId = this.wallClockActiveGoalId;
    if (goalId === null) return null;
    const time = this.wallClockDeltaSeconds();
    if (time === 0) return null;
    return { expectedGoalId: goalId, timeDeltaSeconds: time, tokenDelta: 0 };
  }

  /** Advance baselines after a successful account. */
  markProgressAccountedForStatus(
    turnId: string,
    snapshot: GoalProgressSnapshot,
    status: string,
    clearActive: boolean,
  ): void {
    const turn = this.turns.get(turnId);
    if (turn) {
      const usage = snapshot.usage ?? turn.current;
      turn.lastAccounted = { ...usage, cache: { ...usage.cache } };
      if (clearActive) turn.activeGoalId = null;
    }
    this.advanceWallClock(snapshot.timeDeltaSeconds);
    if (clearActive) this.clearWallClockActive();
    if (status !== "budget_limited") this.budgetLimitReportedGoalId = null;
  }

  markIdleProgressAccountedForStatus(
    snapshot: GoalProgressSnapshot,
    status: string,
    clearActive: boolean,
  ): void {
    this.advanceWallClock(snapshot.timeDeltaSeconds);
    if (clearActive) this.clearWallClockActive();
    if (status !== "budget_limited") this.budgetLimitReportedGoalId = null;
  }

  interruptTurn(turnId: string): void {
    if (this.currentTurnId === turnId) {
      this.currentTurnId = null;
      this.interruptedTurnId = turnId;
    } else {
      this.turns.delete(turnId);
    }
  }

  finishTurn(turnId: string): void {
    this.turns.delete(turnId);
    if (this.currentTurnId === turnId) this.currentTurnId = null;
    if (this.interruptedTurnId === turnId) this.interruptedTurnId = null;
  }

  resetIdleProgressBaselineAndClearActiveGoal(): void {
    this.wallClockBaselineMs = performance.now();
    this.wallClockActiveGoalId = null;
    this.budgetLimitReportedGoalId = null;
  }

  /** Returns true the first time a goal is reported budget-limited. */
  markBudgetLimitReportedIfNew(goalId: string): boolean {
    if (this.budgetLimitReportedGoalId === goalId) return false;
    this.budgetLimitReportedGoalId = goalId;
    return true;
  }

  private wallClockDeltaSeconds(): number {
    return Math.max(0, Math.floor((performance.now() - this.wallClockBaselineMs) / 1000));
  }

  private advanceWallClock(seconds: number): void {
    if (seconds <= 0) return;
    this.wallClockBaselineMs += seconds * 1000;
  }

  private markWallClockActive(goalId: string): void {
    if (this.wallClockActiveGoalId !== goalId) {
      this.wallClockBaselineMs = performance.now();
      this.wallClockActiveGoalId = goalId;
    }
  }

  private clearWallClockActive(): void {
    this.wallClockActiveGoalId = null;
    this.wallClockBaselineMs = performance.now();
  }
}

/** codex `should_clear_active_goal`. */
export function shouldClearActiveGoal(
  status: string,
  budgetLimitedDisposition: "keep_active" | "clear_active",
): boolean {
  if (status === "active") return false;
  if (status === "budget_limited") return budgetLimitedDisposition === "clear_active";
  // paused | blocked | usage_limited | complete
  return true;
}

/** codex `tool_attempt_counts_for_goal_progress`. */
export function toolAttemptCountsForGoalProgress(outcome: ToolOutcome): boolean {
  if (outcome.kind === "completed") return true;
  if (outcome.kind === "failed") return outcome.handlerExecuted;
  return false; // blocked | aborted
}
