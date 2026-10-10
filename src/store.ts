/**
 * Goal persistence & state-machine semantics.
 *
 * Codex's status and budget rules adapted to OpenCode's key-value storage.
 * Each store serializes reads and mutations per session to preserve guarded
 * read/check/write operations. This is not a cross-process storage lock.
 */

export const MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4_000;

export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export const ThreadGoalStatus = {
  isActive(s: ThreadGoalStatus): boolean {
    return s === "active";
  },
  isTerminal(s: ThreadGoalStatus): boolean {
    return s === "budget_limited" || s === "complete";
  },
} as const;

export interface ThreadGoal {
  threadId: string;
  goalId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface GoalUpdate {
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  /** Outer presence = "update the budget field"; inner null = clear it. */
  tokenBudget?: number | null;
  /** Optimistic-concurrency guard: stale writers are rejected (return null). */
  expectedGoalId?: string | null;
}

/** codex `GoalAccountingMode` */
export type GoalAccountingMode =
  | "active_status_only"
  | "active_only"
  | "active_or_complete"
  | "active_or_stopped";

export type GoalAccountingOutcome =
  | { kind: "updated"; goal: ThreadGoal }
  | { kind: "unchanged"; goal: ThreadGoal | null };

/** Minimal key-value backing; bound to `ctx.storage` in the plugin. */
export interface StorageBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function validateThreadGoalObjective(value: string): string | null {
  if (value.trim().length === 0) return "goal objective must not be empty";
  if ([...value].length > MAX_THREAD_GOAL_OBJECTIVE_CHARS) {
    return `goal objective must be at most ${MAX_THREAD_GOAL_OBJECTIVE_CHARS} characters`;
  }
  return null;
}

/** codex `validate_goal_budget` (tool.rs). Returns an error string or null. */
export function validateGoalBudget(
  value: number | null,
  maxGoalTokenBudget: number | null,
): string | null {
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
    return "goal budgets must be positive safe integers when provided";
  }
  if (value !== null && maxGoalTokenBudget !== null && value > maxGoalTokenBudget) {
    return `goal token budget ${value} exceeds the maximum allowed goal token budget of ${maxGoalTokenBudget}`;
  }
  return null;
}

/** OpenCode input/output exclude cache and reasoning; cache writes are uncached work. */
export function goalTokenDeltaForUsage(usage: {
  input: number;
  output: number;
  reasoning?: number;
  cache: { read: number; write?: number };
}): number {
  const positive = (n: number | undefined) => Number.isFinite(n) ? Math.max(0, n ?? 0) : 0;
  return positive(usage.input) + positive(usage.output) + positive(usage.reasoning) + positive(usage.cache.write);
}

/** codex `status_after_budget_limit`. */
function statusAfterBudgetLimit(
  status: ThreadGoalStatus,
  tokensUsed: number,
  tokenBudget: number | null,
): ThreadGoalStatus {
  if (status === "active" && tokenBudget !== null && tokensUsed >= tokenBudget) {
    return "budget_limited";
  }
  return status;
}

const ACCOUNTING_STATUS_FILTERS: Record<GoalAccountingMode, ReadonlySet<ThreadGoalStatus>> = {
  active_status_only: new Set(["active"]),
  active_only: new Set(["active", "budget_limited"]),
  active_or_complete: new Set(["active", "budget_limited", "complete"]),
  active_or_stopped: new Set(["active", "paused", "blocked", "usage_limited", "budget_limited"]),
};

const BUDGET_LIMIT_STATUS_FILTERS: Record<GoalAccountingMode, ReadonlySet<ThreadGoalStatus>> = {
  active_status_only: new Set(["active"]),
  active_only: new Set(["active"]),
  active_or_complete: new Set(["active"]),
  active_or_stopped: new Set(["active", "paused", "blocked", "usage_limited", "budget_limited"]),
};

let counter = 0;
function newGoalId(): string {
  // RFC4122 v4 UUID without a crypto dependency beyond what Node provides.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  counter += 1;
  return `goal-${Date.now().toString(16)}-${counter.toString(16)}-${Math.floor(
    Math.random() * 0xffffffff,
  ).toString(16)}`;
}

export class GoalStore {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    private readonly backend: StorageBackend,
    private readonly keyPrefix = "goal:",
  ) {}

  private key(threadId: string): string {
    return `${this.keyPrefix}${threadId}`;
  }

  /** Serialize the entire read/check/write, including deletes and guarded updates. */
  private async exclusive<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.pending.set(threadId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.pending.get(threadId) === current) this.pending.delete(threadId);
    }
  }

  private async read(threadId: string): Promise<ThreadGoal | null> {
    const raw = await this.backend.get(this.key(threadId));
    if (raw === undefined || raw === null) return null;
    return structuredClone(raw as ThreadGoal);
  }

  private async write(goal: ThreadGoal): Promise<ThreadGoal> {
    await this.backend.set(this.key(goal.threadId), structuredClone(goal));
    return structuredClone(goal);
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return this.exclusive(threadId, () => this.read(threadId));
  }

  /**
   * codex `replace_thread_goal`: unconditional upsert (user API path).
   * Resets usage to 0, assigns a fresh goal_id.
   */
  async replaceThreadGoal(
    threadId: string,
    objective: string,
    status: ThreadGoalStatus,
    tokenBudget: number | null,
  ): Promise<ThreadGoal> {
    return this.exclusive(threadId, () => this.replace(threadId, objective, status, tokenBudget));
  }

  private async replace(
    threadId: string,
    objective: string,
    status: ThreadGoalStatus,
    tokenBudget: number | null,
  ): Promise<ThreadGoal> {
    const error = validateThreadGoalObjective(objective);
    if (error) throw new Error(error);
    const now = Date.now();
    const finalStatus = statusAfterBudgetLimit(status, 0, tokenBudget);
    const goal: ThreadGoal = {
      threadId,
      goalId: newGoalId(),
      objective,
      status: finalStatus,
      tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    return this.write(goal);
  }

  /**
   * codex `insert_thread_goal` (agent `create_goal` tool path): only succeeds
   * when no goal exists or the existing one is `complete`. Returns null when
   * an unfinished goal already exists.
   */
  async insertThreadGoal(
    threadId: string,
    objective: string,
    status: ThreadGoalStatus,
    tokenBudget: number | null,
  ): Promise<ThreadGoal | null> {
    return this.exclusive(threadId, async () => {
      const existing = await this.read(threadId);
      if (existing !== null && existing.status !== "complete") return null;
      return this.replace(threadId, objective, status, tokenBudget);
    });
  }

  /**
   * codex `update_thread_goal`. Applies partial updates with the same
   * status-precedence rules as the SQL `CASE`:
   *  - paused/blocked never clobber `budget_limited`;
   *  - setting `active` while over budget lands on `budget_limited`;
   *  - lowering the budget below current usage flips `active` -> `budget_limited`.
   * Returns null when no goal exists or `expectedGoalId` does not match.
   */
  async updateThreadGoal(threadId: string, update: GoalUpdate): Promise<ThreadGoal | null> {
    return this.exclusive(threadId, () => this.update(threadId, update));
  }

  private async update(threadId: string, update: GoalUpdate): Promise<ThreadGoal | null> {
    const goal = await this.read(threadId);
    if (goal === null) return null;
    if (
      update.expectedGoalId !== null &&
      update.expectedGoalId !== undefined &&
      goal.goalId !== update.expectedGoalId
    ) {
      return null;
    }

    const next: ThreadGoal = { ...goal, updatedAtMs: Date.now() };
    if (update.objective !== null && update.objective !== undefined) {
      const error = validateThreadGoalObjective(update.objective);
      if (error) throw new Error(error);
      next.objective = update.objective;
    }

    const hasStatus = update.status !== null && update.status !== undefined;
    const hasBudget = update.tokenBudget !== undefined;
    const newStatus = hasStatus ? (update.status as ThreadGoalStatus) : null;
    const newBudget = hasBudget ? (update.tokenBudget as number | null) : undefined;

    if (newBudget !== undefined) next.tokenBudget = newBudget;

    if (newStatus !== null) {
      // WHEN status = 'budget_limited' AND new IN ('paused','blocked') THEN keep status
      if (
        goal.status === "budget_limited" &&
        (newStatus === "paused" || newStatus === "blocked")
      ) {
        next.status = goal.status;
      } else if (
        // WHEN new = 'active' AND budget IS NOT NULL AND tokens_used >= budget THEN 'budget_limited'
        newStatus === "active" &&
        next.tokenBudget !== null &&
        next.tokensUsed >= next.tokenBudget
      ) {
        next.status = "budget_limited";
      } else {
        next.status = newStatus;
      }
    } else if (newBudget !== undefined) {
      // Budget-only update: WHEN status='active' AND new budget IS NOT NULL AND tokens_used >= new THEN 'budget_limited'
      if (
        goal.status === "active" &&
        newBudget !== null &&
        next.tokensUsed >= newBudget
      ) {
        next.status = "budget_limited";
      }
    }

    return this.write(next);
  }

  /** codex `pause_active_thread_goal` — only transitions an `active` goal. */
  async pauseActiveThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return this.updateActiveThreadGoalStatus(threadId, "paused");
  }

  /** codex `usage_limit_active_thread_goal` — active, or budget_limited -> usage_limited. */
  async usageLimitActiveThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return this.updateActiveThreadGoalStatus(threadId, "usage_limited");
  }

  private async updateActiveThreadGoalStatus(
    threadId: string,
    status: ThreadGoalStatus,
  ): Promise<ThreadGoal | null> {
    return this.exclusive(threadId, async () => {
      const goal = await this.read(threadId);
      if (goal === null) return null;
      const allowed =
        goal.status === "active" ||
        (status === "usage_limited" && goal.status === "budget_limited");
      if (!allowed) return null;
      return this.write({ ...goal, status, updatedAtMs: Date.now() });
    });
  }

  /** codex `delete_thread_goal`. Returns the deleted goal, or null. */
  async deleteThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return this.exclusive(threadId, async () => {
      const goal = await this.read(threadId);
      if (goal === null) return null;
      await this.backend.remove(this.key(threadId));
      return goal;
    });
  }

  /**
   * codex `account_thread_goal_usage`: atomically add time+token deltas and
   * flip to `budget_limited` when the budget is crossed, scoped by mode and
   * `expectedGoalId`. Returns `unchanged` when the current status is outside
   * the mode's filter (or no goal), without mutating.
   */
  async accountThreadGoalUsage(
    threadId: string,
    timeDeltaSeconds: number,
    tokenDelta: number,
    mode: GoalAccountingMode,
    expectedGoalId: string | null = null,
  ): Promise<GoalAccountingOutcome> {
    return this.exclusive(threadId, () => this.account(threadId, timeDeltaSeconds, tokenDelta, mode, expectedGoalId));
  }

  private async account(
    threadId: string,
    timeDeltaSeconds: number,
    tokenDelta: number,
    mode: GoalAccountingMode,
    expectedGoalId: string | null,
  ): Promise<GoalAccountingOutcome> {
    if (!Number.isFinite(timeDeltaSeconds) || !Number.isFinite(tokenDelta)) {
      throw new Error("goal usage deltas must be finite");
    }
    const t = Math.max(0, Math.floor(timeDeltaSeconds));
    const tok = Math.max(0, Math.floor(tokenDelta));
    const current = await this.read(threadId);
    if (t === 0 && tok === 0) return { kind: "unchanged", goal: current };
    if (current === null) return { kind: "unchanged", goal: null };
    if (expectedGoalId !== null && current.goalId !== expectedGoalId) {
      return { kind: "unchanged", goal: current };
    }
    if (!ACCOUNTING_STATUS_FILTERS[mode].has(current.status)) {
      return { kind: "unchanged", goal: current };
    }

    const tokensUsed = current.tokensUsed + tok;
    let status = current.status;
    if (
      BUDGET_LIMIT_STATUS_FILTERS[mode].has(current.status) &&
      current.tokenBudget !== null &&
      tokensUsed >= current.tokenBudget
    ) {
      status = "budget_limited";
    }

    const updated: ThreadGoal = {
      ...current,
      status,
      tokensUsed,
      timeUsedSeconds: current.timeUsedSeconds + t,
      updatedAtMs: Date.now(),
    };
    await this.write(updated);
    return { kind: "updated", goal: updated };
  }
}

/** In-memory backend for tests and non-persistent sessions. */
export class MemoryStorageBackend implements StorageBackend {
  private readonly map = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return structuredClone(this.map.get(key));
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}
