/* @jsxImportSource @opentui/solid */
/**
 * oc-goal TUI plugin: renders the active goal's status + elapsed time in the
 * prompt footer (in-session bottom row) and registers a `/goal` slash command
 * that talks to the server plugin over RPC.
 */

import { Plugin } from "@opencode/plugin/tui";
import { createSignal, createEffect, createComponent, Show } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { goalRpc, type GoalStatusPayload } from "./rpc.js";

const EMPTY = (sessionID: string): GoalStatusPayload => ({
  sessionID,
  status: "",
  objective: null,
  goalStatus: null,
  tokensUsed: null,
  tokenBudget: null,
  timeUsedSeconds: null,
});

export default Plugin.define({
  id: "oc-goal",
  setup(ctx) {
    if (ctx.options.enabled === false) return;
    const rpc = ctx.client.rpc(goalRpc);
    let disposed = false;
    const versions = new Map<string, number>();
    const requests = new Map<string, number>();

    // Reactive per-session goal status, fed by an initial fetch + live events.
    const [goalBySession, setGoalBySession] = createSignal<Record<string, GoalStatusPayload>>({});

    function applyPayload(payload: GoalStatusPayload): void {
      if (disposed) return;
      versions.set(payload.sessionID, (versions.get(payload.sessionID) ?? 0) + 1);
      setGoalBySession((prev) => ({ ...prev, [payload.sessionID]: payload }));
    }

    async function refresh(sessionID: string): Promise<void> {
      const version = versions.get(sessionID) ?? 0;
      const request = (requests.get(sessionID) ?? 0) + 1;
      requests.set(sessionID, request);
      try {
        const payload = (await rpc.get({ sessionID })) as unknown as GoalStatusPayload;
        if (version === (versions.get(sessionID) ?? 0) && requests.get(sessionID) === request) applyPayload(payload);
      } catch {
        if (!goalBySession()[sessionID] && requests.get(sessionID) === request) applyPayload(EMPTY(sessionID));
      }
    }

    const unsubscribe = rpc.events.on("changed", (event) => {
      applyPayload(event.data as unknown as GoalStatusPayload);
    });

    // -- footer status ---------------------------------------------------------
    // codex-style: show the goal status + elapsed time on the bottom row while
    // a session has a goal. prompt.footer.status is the in-session status row.
    const disposeSlot = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const status = () => input.sessionID ? goalBySession()[input.sessionID]?.status : "";
        createEffect(() => {
          const sessionID = input.sessionID;
          if (sessionID) void refresh(sessionID);
        });
        // Explicit getters preserve Solid reactivity in tsc's shipped JS output.
        return createComponent(Show, {
          keyed: true,
          get when() { return status(); },
          get children() {
            return jsx("text", {
              get fg() { return ctx.theme.text.muted; },
              get children() { return status(); },
            });
          },
        });
      },
    });

    // -- /goal slash command ------------------------------------------------------
    // Registering via keymap.slash keeps the typed argument out of the transcript
    // and routes it straight to the server plugin over RPC.
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "oc-goal.goal",
          title: "Manage goal",
          group: "Goal",
          slash: { name: "goal", arguments: true },
          run: async (input) => {
            const route = ctx.ui.router.current();
            if (route.type !== "session") {
              ctx.ui.toast.show({ message: "Open a session to manage its goal", variant: "warning" });
              return;
            }
            const sessionID = route.sessionID;
            try {
              const res = (await rpc.command({ sessionID, argument: input ?? "" })) as unknown as {
                message: string;
              };
              ctx.ui.toast.show({ message: res.message, variant: "info" });
              await refresh(sessionID);
            } catch (err) {
              ctx.ui.toast.show({ message: `goal: ${String(err)}`, variant: "error" });
            }
          },
        },
      ],
    }));

    return () => {
      disposed = true;
      unsubscribe();
      disposeSlot();
    };
  },
});
