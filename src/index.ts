/** Persistent session goals, with OpenCode-specific event and usage accounting. */
import { Plugin } from "@opencode/plugin";
import { GoalStore, type ThreadGoal } from "./store.js";
import {
  CREATE_GOAL_DESCRIPTION, CREATE_GOAL_TOOL_NAME, GET_GOAL_DESCRIPTION, GET_GOAL_TOOL_NAME,
  OBJECTIVE_PARAM_DESCRIPTION, TOKEN_BUDGET_PARAM_DESCRIPTION, UPDATE_GOAL_DESCRIPTION,
  UPDATE_GOAL_TOOL_NAME, UPDATE_STATUS_PARAM_DESCRIPTION,
} from "./spec.js";
import { GoalToolHandlers, type CreateGoalInput, type UpdateGoalInput } from "./tool.js";
import { goalRpc, type GoalStatusPayload } from "./rpc.js";
import { GoalRuntime, type GoalPluginOptions } from "./runtime.js";

function parseOptions(raw: unknown): GoalPluginOptions {
  const opts = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: opts.enabled !== false,
    maxGoalTokenBudget: typeof opts.maxGoalTokenBudget === "number" && Number.isSafeInteger(opts.maxGoalTokenBudget) && opts.maxGoalTokenBudget > 0 ? opts.maxGoalTokenBudget : null,
    maxContinuationTurns: typeof opts.maxContinuationTurns === "number" && Number.isSafeInteger(opts.maxContinuationTurns) && opts.maxContinuationTurns >= 0 ? opts.maxContinuationTurns : 0,
  };
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
}

function statusPayload(sessionID: string, goal: ThreadGoal | null): GoalStatusPayload {
  return {
    sessionID,
    status: goal ? `goal:${goal.status} ${goal.tokensUsed}${goal.tokenBudget !== null ? `/${goal.tokenBudget}` : ""}tok ${formatElapsed(goal.timeUsedSeconds)}` : "",
    objective: goal?.objective ?? null, goalStatus: goal?.status ?? null,
    tokensUsed: goal?.tokensUsed ?? null, tokenBudget: goal?.tokenBudget ?? null,
    timeUsedSeconds: goal?.timeUsedSeconds ?? null,
  };
}

export default Plugin.define({
  id: "oc-goal",
  async setup(ctx) {
    const opts = parseOptions(ctx.options);
    const log = (message: string) => console.error(`[oc-goal] ${message}`);
    const store = new GoalStore({
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, value as never),
      remove: (key) => ctx.storage.remove(key),
    });
    let emitChanged: (sessionID: string) => Promise<void> = async () => {};
    const runtime = new GoalRuntime(store, ctx.session, opts, (id) => emitChanged(id), log);
    const handlers = new GoalToolHandlers(store, opts.maxGoalTokenBudget, {
      onGoalCreated: (goal) => runtime.goalCreated(goal),
      onGoalUpdated: (goal) => runtime.goalUpdated(goal),
    });

    const tools = await ctx.tool.transform((editor) => {
      if (!opts.enabled) return;
      editor.add({
        name: GET_GOAL_TOOL_NAME, description: GET_GOAL_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false } as never,
        execute: (_input, context) => runtime.exclusive(context.sessionID, async () => {
          await runtime.account(context.sessionID);
          return { content: JSON.stringify(await handlers.get(context.sessionID)) };
        }),
      });
      editor.add({
        name: CREATE_GOAL_TOOL_NAME, description: CREATE_GOAL_DESCRIPTION,
        input: {
          type: "object", properties: {
            objective: { type: "string", description: OBJECTIVE_PARAM_DESCRIPTION },
            token_budget: { type: "integer", minimum: 1, description: TOKEN_BUDGET_PARAM_DESCRIPTION },
          }, required: ["objective"], additionalProperties: false,
        } as never,
        execute: (input, context) => runtime.exclusive(context.sessionID, async () => {
          const response = await handlers.create(context.sessionID, input as CreateGoalInput);
          await emitChanged(context.sessionID);
          return { content: JSON.stringify(response) };
        }),
      });
      editor.add({
        name: UPDATE_GOAL_TOOL_NAME, description: UPDATE_GOAL_DESCRIPTION,
        input: {
          type: "object", properties: {
            status: { type: "string", enum: ["complete", "blocked", "paused"], description: UPDATE_STATUS_PARAM_DESCRIPTION },
          }, required: ["status"], additionalProperties: false,
        } as never,
        execute: (input, context) => runtime.exclusive(context.sessionID, async () => {
          await runtime.account(context.sessionID);
          const response = await handlers.update(context.sessionID, input as UpdateGoalInput);
          await emitChanged(context.sessionID);
          return { content: JSON.stringify(response) };
        }),
      });
    });

    const rpc = await ctx.rpc.register(goalRpc, {
      async get(input) {
        const { sessionID } = input as { sessionID: string };
        return statusPayload(sessionID, opts.enabled ? await store.getThreadGoal(sessionID) : null);
      },
      async command(input) {
        const { sessionID, argument } = input as { sessionID: string; argument: string };
        return { message: await runtime.command(sessionID, argument) };
      },
    });
    emitChanged = async (id) => rpc.events.emit("changed", { ...statusPayload(id, await store.getThreadGoal(id)) });
    const commands = await ctx.command.transform((editor) => {
      if (!opts.enabled) return;
      editor.add({
        name: "goal",
        description: "Manage this session's goal: /goal [objective] | status | clear | pause | resume | budget [tokens|none]",
        async execute(input) {
          const message = await runtime.command(input.sessionID, input.prompt.text ?? "");
          await runtime.notice(input.sessionID, message);
        },
      });
    });

    const contextHook = opts.enabled ? await ctx.session.hook("context", async (input) => {
      const text = await runtime.context(input.sessionID);
      if (text) input.messages.push({ role: "user", content: [{ type: "text", text }] });
    }) : undefined;

    const controller = new AbortController();
    const events = opts.enabled ? (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try { await runtime.event(event); }
          catch (error) { log(`event ${event.type} failed: ${String(error)}`); }
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`event stream ended unexpectedly: ${String(error)}`);
      }
    })() : Promise.resolve();
    const timer = opts.enabled ? setInterval(() => { void runtime.tick().catch((error) => log(`usage tick failed: ${String(error)}`)); }, 1000) : undefined;
    timer?.unref();
    log(`loaded (enabled=${opts.enabled}, maxGoalTokenBudget=${opts.maxGoalTokenBudget ?? "none"})`);
    return async () => {
      runtime.dispose();
      controller.abort();
      clearInterval(timer);
      await events;
      await Promise.all([tools.dispose(), commands.dispose(), rpc.dispose()]);
      await contextHook?.dispose();
    };
  },
});
