/**
 * oc-goal: persistent thread goals for OpenCode, ported from codex's
 * `codex-rs/ext/goal` feature.
 *
 * Provides three model tools (get_goal / create_goal / update_goal), token &
 * wall-clock usage accounting against an optional token budget, and automatic
 * continuation turns that keep an active goal moving when the session goes
 * idle — with budget-limit, objective-updated and continuation steering
 * prompts copied verbatim from codex.
 */

import { Plugin } from "@opencode/plugin";
import { GoalAccountingState, shouldClearActiveGoal } from "./accounting.js";
import { GoalStore, type ThreadGoal, type ThreadGoalStatus } from "./store.js";
import {
  CREATE_GOAL_DESCRIPTION,
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_DESCRIPTION,
  GET_GOAL_TOOL_NAME,
  OBJECTIVE_PARAM_DESCRIPTION,
  TOKEN_BUDGET_PARAM_DESCRIPTION,
  UPDATE_GOAL_DESCRIPTION,
  UPDATE_GOAL_TOOL_NAME,
  UPDATE_STATUS_PARAM_DESCRIPTION,
} from "./spec.js";
import { budgetLimitPrompt, continuationPrompt, objectiveUpdatedPrompt } from "./steering.js";
import { GoalToolHandlers, ToolError } from "./tool.js";

interface GoalPluginOptions {
  enabled: boolean;
  maxGoalTokenBudget: number | null;
  /** Bound a single continuation loop when there is no budget. 0 = unlimited. */
  maxContinuationTurns: number;
}

function parseOptions(raw: unknown): GoalPluginOptions {
  const opts = (raw ?? {}) as Record<string, unknown>;
  const maxBudget =
    typeof opts.maxGoalTokenBudget === "number" &&
    Number.isFinite(opts.maxGoalTokenBudget) &&
    opts.maxGoalTokenBudget > 0
      ? Math.floor(opts.maxGoalTokenBudget)
      : null;
  const maxContinuationTurns =
    typeof opts.maxContinuationTurns === "number" &&
    Number.isFinite(opts.maxContinuationTurns) &&
    opts.maxContinuationTurns >= 0
      ? Math.floor(opts.maxContinuationTurns)
      : 0;
  return {
    enabled: opts.enabled !== false,
    maxGoalTokenBudget: maxBudget,
    maxContinuationTurns,
  };
}

interface SessionRuntime {
  accounting: GoalAccountingState;
  turnSeq: number;
  currentTurnId: string | null;
  /** True while the current turn was started by an automatic continuation. */
  currentTurnAutomatic: boolean;
  /** Continuation turns started for the current goal instance. */
  continuationCount: number;
  /** Set once a goal completes/blocks/pauses so we stop continuing. */
  stopped: boolean;
}

export default Plugin.define({
  id: "oc-goal",
  async setup(ctx) {
    const opts = parseOptions(ctx.options);
    const log = (m: string) => console.error(`[oc-goal] ${m}`);
    const store = new GoalStore({
      get: (k) => ctx.storage.get(k),
      set: (k, v) => ctx.storage.set(k, v as never),
      remove: (k) => ctx.storage.remove(k),
    });
    const sessions = new Map<string, SessionRuntime>();

    function runtimeFor(sessionID: string): SessionRuntime {
      let rt = sessions.get(sessionID);
      if (!rt) {
        rt = {
          accounting: new GoalAccountingState(),
          turnSeq: 0,
          currentTurnId: null,
          currentTurnAutomatic: false,
          continuationCount: 0,
          stopped: false,
        };
        sessions.set(sessionID, rt);
      }
      return rt;
    }

    const handlers = new GoalToolHandlers(store, opts.maxGoalTokenBudget, {
      onGoalCreated(goal) {
        const rt = runtimeFor(goal.threadId);
        rt.stopped = false;
        rt.continuationCount = 0;
        rt.accounting.markCurrentTurnGoalActive(goal.goalId);
      },
      onGoalUpdated(goal) {
        const rt = runtimeFor(goal.threadId);
        if (goal.status !== "active") {
          rt.stopped = true;
          rt.accounting.clearActiveGoal();
        }
      },
    });

    // -- tools ---------------------------------------------------------------
    const reg = await ctx.tool.transform((editor) => {
      if (!opts.enabled) return;

      editor.add({
        name: GET_GOAL_TOOL_NAME,
        description: GET_GOAL_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false } as never,
        async execute(_input, toolCtx) {
          const res = await handlers.get(toolCtx.sessionID);
          return { content: JSON.stringify(res) };
        },
      });

      editor.add({
        name: CREATE_GOAL_TOOL_NAME,
        description: CREATE_GOAL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            objective: { type: "string", description: OBJECTIVE_PARAM_DESCRIPTION },
            token_budget: { type: "integer", description: TOKEN_BUDGET_PARAM_DESCRIPTION },
          },
          required: ["objective"],
          additionalProperties: false,
        } as never,
        async execute(input, toolCtx) {
          try {
            const res = await handlers.create(toolCtx.sessionID, input as never);
            return { content: JSON.stringify(res) };
          } catch (err) {
            if (err instanceof ToolError) throw new Error(err.message);
            throw err;
          }
        },
      });

      editor.add({
        name: UPDATE_GOAL_TOOL_NAME,
        description: UPDATE_GOAL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["complete", "blocked", "paused"],
              description: UPDATE_STATUS_PARAM_DESCRIPTION,
            },
          },
          required: ["status"],
          additionalProperties: false,
        } as never,
        async execute(input, toolCtx) {
          try {
            // Account in-flight progress before the status transition.
            const rt = runtimeFor(toolCtx.sessionID);
            if (rt.currentTurnId) {
              await accountTurnProgress(
                toolCtx.sessionID,
                rt.currentTurnId,
                (input as { status: string }).status === "complete"
                  ? "active_or_complete"
                  : "active_or_stopped",
                "clear_active",
              );
            }
            const res = await handlers.update(toolCtx.sessionID, input as never);
            return { content: JSON.stringify(res) };
          } catch (err) {
            if (err instanceof ToolError) throw new Error(err.message);
            throw err;
          }
        },
      });
    });

    // -- accounting helpers ----------------------------------------------------
    async function accountTurnProgress(
      sessionID: string,
      turnId: string,
      mode: "active_status_only" | "active_only" | "active_or_complete" | "active_or_stopped",
      budgetDisposition: "keep_active" | "clear_active",
    ): Promise<{ goal: ThreadGoal; flippedToBudgetLimited: boolean } | null> {
      const rt = runtimeFor(sessionID);
      const snapshot = rt.accounting.progressSnapshot(turnId);
      if (!snapshot) return null;
      const before = await store.getThreadGoal(sessionID);
      const outcome = await store.accountThreadGoalUsage(
        sessionID,
        snapshot.timeDeltaSeconds,
        snapshot.tokenDelta,
        mode,
        snapshot.expectedGoalId,
      );
      if (outcome.kind !== "updated") return null;
      const goal = outcome.goal;
      const clearActive = shouldClearActiveGoal(goal.status, budgetDisposition);
      rt.accounting.markProgressAccountedForStatus(turnId, snapshot, goal.status, clearActive);
      const flipped =
        goal.status === "budget_limited" &&
        before !== null &&
        before.status === "active" &&
        rt.accounting.markBudgetLimitReportedIfNew(goal.goalId);
      return { goal, flippedToBudgetLimited: flipped };
    }

    async function continueIfIdle(sessionID: string): Promise<void> {
      if (!opts.enabled) return;
      const rt = runtimeFor(sessionID);
      const goal = await store.getThreadGoal(sessionID);
      if (!goal || goal.status !== "active") {
        rt.accounting.clearActiveGoal();
        return;
      }
      if (opts.maxContinuationTurns > 0 && rt.continuationCount >= opts.maxContinuationTurns) {
        log(`session=${sessionID} hit maxContinuationTurns=${opts.maxContinuationTurns}; pausing continuation`);
        return;
      }
      rt.continuationCount += 1;
      rt.currentTurnAutomatic = true;
      const text = continuationPrompt(goal);
      try {
        await ctx.session.prompt({
          sessionID,
          text,
          metadata: { ocGoalContinuation: true },
        } as never);
        log(`session=${sessionID} goal continuation #${rt.continuationCount} dispatched`);
      } catch (err) {
        rt.currentTurnAutomatic = false;
        log(`session=${sessionID} goal continuation failed: ${String(err)}`);
      }
    }

    // -- lifecycle events ------------------------------------------------------
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!opts.enabled) continue;
          const type = event.type as string;
          const data = (event as { data?: Record<string, unknown> }).data ?? {};
          const sessionID = data.sessionID as string | undefined;
          if (!sessionID) continue;
          const rt = runtimeFor(sessionID);

          switch (type) {
            case "session.step.started": {
              // New model step => treat as a new goal turn.
              rt.turnSeq += 1;
              const turnId = `turn-${rt.turnSeq}`;
              rt.currentTurnId = turnId;
              rt.accounting.startTurn(turnId, true);
              const goal = await store.getThreadGoal(sessionID);
              if (goal && (goal.status === "active" || goal.status === "budget_limited")) {
                rt.accounting.markTurnGoalActive(turnId, goal.goalId);
                if (rt.currentTurnAutomatic) {
                  rt.accounting.markGoalContinuation(turnId);
                }
              }
              break;
            }

            case "session.usage.updated": {
              const tokens = data.tokens as
                | { input: number; output: number; cache: { read: number; write: number } }
                | undefined;
              if (tokens && rt.currentTurnId) {
                rt.accounting.recordTokenUsage(rt.currentTurnId, tokens);
              }
              break;
            }

            case "session.tool.success":
            case "session.tool.called":
            case "session.text.delta":
            case "session.text.ended": {
              if (rt.currentTurnId) {
                rt.accounting.recordActivity(rt.currentTurnId, true, false);
              }
              break;
            }

            case "session.step.ended": {
              if (rt.currentTurnId) {
                const res = await accountTurnProgress(
                  sessionID,
                  rt.currentTurnId,
                  "active_only",
                  "keep_active",
                );
                if (res?.flippedToBudgetLimited) {
                  await ctx.session.prompt({
                    sessionID,
                    text: budgetLimitPrompt(res.goal),
                    delivery: "steer",
                    metadata: { ocGoalSteering: true },
                  } as never);
                  log(`session=${sessionID} goal budget_limited; steering injected`);
                }
              }
              break;
            }

            case "session.execution.succeeded": {
              if (rt.currentTurnId) {
                await accountTurnProgress(sessionID, rt.currentTurnId, "active_only", "clear_active");
                rt.accounting.finishTurn(rt.currentTurnId);
                rt.currentTurnId = null;
              }
              rt.currentTurnAutomatic = false;
              break;
            }

            case "session.execution.interrupted": {
              if (rt.currentTurnId) {
                await accountTurnProgress(sessionID, rt.currentTurnId, "active_only", "clear_active");
                rt.accounting.interruptTurn(rt.currentTurnId);
                rt.currentTurnId = null;
              }
              rt.currentTurnAutomatic = false;
              break;
            }

            case "session.execution.failed": {
              const err = data.error as { type?: string; message?: string } | undefined;
              const msg = `${err?.type ?? ""} ${err?.message ?? ""}`.toLowerCase();
              const usageLimited = /usage.?limit|quota|insufficient/.test(msg);
              if (rt.currentTurnId) {
                const goal = await store.getThreadGoal(sessionID);
                if (goal && (goal.status === "active" || goal.status === "budget_limited")) {
                  if (usageLimited) {
                    await store.usageLimitActiveThreadGoal(sessionID);
                    log(`session=${sessionID} goal marked usage_limited after error`);
                  } else {
                    await store.updateThreadGoal(sessionID, { status: "blocked" });
                    log(`session=${sessionID} goal marked blocked after turn error`);
                  }
                  rt.accounting.clearActiveGoal();
                  rt.stopped = true;
                }
                rt.accounting.finishTurn(rt.currentTurnId);
                rt.currentTurnId = null;
              }
              rt.currentTurnAutomatic = false;
              break;
            }

            case "session.idle": {
              // Account idle wall-clock progress, then continue an active goal.
              const idleSnap = rt.accounting.idleProgressSnapshot();
              if (idleSnap) {
                await store.accountThreadGoalUsage(
                  sessionID,
                  idleSnap.timeDeltaSeconds,
                  idleSnap.tokenDelta,
                  "active_only",
                  idleSnap.expectedGoalId,
                );
                rt.accounting.markIdleProgressAccountedForStatus(idleSnap, "active", false);
              }
              if (!rt.stopped) await continueIfIdle(sessionID);
              break;
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) log(`event stream ended unexpectedly: ${String(err)}`);
      }
    })();

    // -- user commands -----------------------------------------------------------
    const cmdReg = await ctx.command.transform((editor) => {
      if (!opts.enabled) return;
      editor.add({
        name: "goal",
        description: "Manage this session's goal: /goal [objective] | status | clear | pause | resume",
        async execute(input) {
          const sessionID = input.sessionID;
          const arg = (input.prompt.text ?? "").trim();
          const rt = runtimeFor(sessionID);

          const reply = async (text: string) => {
            await ctx.session.prompt({ sessionID, text, metadata: { ocGoalNotice: true } } as never);
          };

          if (!arg || arg === "status") {
            const goal = await store.getThreadGoal(sessionID);
            if (!goal) {
              await reply("No goal set for this session.");
              return;
            }
            await reply(
              `Goal status: ${goal.status}\nObjective: ${goal.objective}\n` +
                `Tokens: ${goal.tokensUsed}${goal.tokenBudget !== null ? ` / ${goal.tokenBudget}` : ""}\n` +
                `Time: ${goal.timeUsedSeconds}s`,
            );
            return;
          }

          if (arg === "clear") {
            await store.deleteThreadGoal(sessionID);
            rt.stopped = true;
            rt.accounting.clearActiveGoal();
            await reply("Goal cleared.");
            return;
          }

          if (arg === "pause") {
            const goal = await store.pauseActiveThreadGoal(sessionID);
            if (goal) {
              rt.stopped = true;
              rt.accounting.clearActiveGoal();
              await reply("Goal paused.");
            } else {
              await reply("No active goal to pause.");
            }
            return;
          }

          if (arg === "resume") {
            const goal = await store.updateThreadGoal(sessionID, { status: "active" });
            if (goal && goal.status === "active") {
              rt.stopped = false;
              rt.continuationCount = 0;
              rt.accounting.markIdleGoalActive(goal.goalId);
              await reply("Goal resumed.");
              await continueIfIdle(sessionID);
            } else {
              const g = await store.getThreadGoal(sessionID);
              await reply(g ? `Goal is ${g.status}; cannot resume.` : "No goal to resume.");
            }
            return;
          }

          // Otherwise treat the arg as a new objective (replace existing).
          const existing = await store.getThreadGoal(sessionID);
          const previousObjective = existing?.objective ?? null;
          const goal = await store.replaceThreadGoal(
            sessionID,
            arg,
            "active",
            opts.maxGoalTokenBudget,
          );
          rt.stopped = false;
          rt.continuationCount = 0;
          rt.accounting.markIdleGoalActive(goal.goalId);
          await reply(`Goal set (${goal.status}): ${goal.objective}`);
          // If a turn is running and the objective changed, inject steering.
          if (previousObjective !== null && previousObjective !== goal.objective && rt.currentTurnId) {
            await ctx.session.prompt({
              sessionID,
              text: objectiveUpdatedPrompt(goal),
              delivery: "steer",
              metadata: { ocGoalSteering: true },
            } as never);
          } else if (!rt.currentTurnId) {
            await continueIfIdle(sessionID);
          }
        },
      });
    });

    log(`oc-goal loaded (enabled=${opts.enabled}, maxGoalTokenBudget=${opts.maxGoalTokenBudget ?? "none"})`);

    return () => {
      controller.abort();
      void reg.dispose();
      void cmdReg.dispose();
    };
  },
});
