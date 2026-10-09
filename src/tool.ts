/**
 * Tool handler business logic, ported from codex `ext/goal/src/tool.rs`.
 * Decoupled from the plugin runtime so it can be unit-tested directly.
 */

import {
  GoalStore,
  validateGoalBudget,
  validateThreadGoalObjective,
  type ThreadGoal,
  type ThreadGoalStatus,
} from "./store.js";
import {
  COMPLETION_BUDGET_REPORT,
  CREATE_GOAL_CONFLICT_ERROR,
  NO_GOAL_ERROR,
  UPDATE_GOAL_STATUS_ERROR,
} from "./spec.js";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface GoalToolResponse {
  goal: ThreadGoal | null;
  remainingTokens: number | null;
  completionBudgetReport: string | null;
}

function toResponse(goal: ThreadGoal | null, includeReport: boolean): GoalToolResponse {
  const remainingTokens =
    goal !== null && goal.tokenBudget !== null
      ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
      : null;
  const completionBudgetReport =
    includeReport && goal !== null && goal.status === "complete"
      ? goal.tokenBudget !== null || goal.timeUsedSeconds > 0
        ? COMPLETION_BUDGET_REPORT
        : null
      : null;
  return { goal, remainingTokens, completionBudgetReport };
}

export interface CreateGoalInput {
  objective: string;
  token_budget?: number | null;
}

export interface UpdateGoalInput {
  status: string;
}

export class GoalToolHandlers {
  constructor(
    private readonly store: GoalStore,
    private readonly maxGoalTokenBudget: number | null,
    /** Called after create/update so the runtime can mark the turn goal-active / clear it. */
    private readonly hooks: {
      onGoalCreated?: (goal: ThreadGoal) => void;
      /**
       * Account in-flight progress before the status transition so final usage
       * is preserved. codex does this with ActiveOrComplete / ActiveOrStopped
       * inside the update handler. Must run before the status write.
       */
      beforeUpdate?: (status: ThreadGoalStatus) => Promise<void> | void;
      onGoalUpdated?: (goal: ThreadGoal) => void;
    } = {},
  ) {}

  async get(threadId: string): Promise<GoalToolResponse> {
    const goal = await this.store.getThreadGoal(threadId);
    return toResponse(goal, false);
  }

  async create(threadId: string, input: CreateGoalInput): Promise<GoalToolResponse> {
    const objective = (input.objective ?? "").trim();
    const objErr = validateThreadGoalObjective(objective);
    if (objErr) throw new ToolError(objErr);

    const budget = input.token_budget ?? this.maxGoalTokenBudget;
    const budgetErr = validateGoalBudget(budget, this.maxGoalTokenBudget);
    if (budgetErr) throw new ToolError(budgetErr);

    const goal = await this.store.insertThreadGoal(threadId, objective, "active", budget);
    if (goal === null) throw new ToolError(CREATE_GOAL_CONFLICT_ERROR);

    this.hooks.onGoalCreated?.(goal);
    return toResponse(goal, false);
  }

  async update(threadId: string, input: UpdateGoalInput): Promise<GoalToolResponse> {
    const status = input.status as ThreadGoalStatus;
    if (status !== "complete" && status !== "blocked" && status !== "paused") {
      throw new ToolError(UPDATE_GOAL_STATUS_ERROR);
    }

    // Account in-flight progress before the status transition so the final
    // accounting is preserved (codex does this with ActiveOrComplete /
    // ActiveOrStopped inside the update handler).
    await this.hooks.beforeUpdate?.(status);

    const goal = await this.store.updateThreadGoal(threadId, {
      objective: null,
      status,
      tokenBudget: null,
      expectedGoalId: null,
    });
    if (goal === null) throw new ToolError(NO_GOAL_ERROR);

    this.hooks.onGoalUpdated?.(goal);
    return toResponse(goal, status === "complete");
  }
}
