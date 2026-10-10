/**
 * RPC contract shared between the oc-goal server plugin and its TUI plugin.
 * The server registers handlers + emits `changed` events; the TUI calls
 * `get` and subscribes to `changed` to render the footer status live.
 */

import { Rpc } from "@opencode/plugin";

export interface GoalStatusPayload {
  sessionID: string;
  /** Pre-rendered footer text, e.g. "goal:active 1234/50000tok 2m10s". */
  status: string;
  objective: string | null;
  goalStatus: string | null;
  tokensUsed: number | null;
  tokenBudget: number | null;
  timeUsedSeconds: number | null;
}

const goalStatusSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    status: { type: "string" },
    objective: { type: ["string", "null"] },
    goalStatus: { type: ["string", "null"] },
    tokensUsed: { type: ["number", "null"] },
    tokenBudget: { type: ["number", "null"] },
    timeUsedSeconds: { type: ["number", "null"] },
  },
  required: [
    "sessionID",
    "status",
    "objective",
    "goalStatus",
    "tokensUsed",
    "tokenBudget",
    "timeUsedSeconds",
  ],
  additionalProperties: false,
} as const;

export const goalRpc = Rpc.define({
  id: "oc-goal",
  methods: {
    /** Get the goal status payload for a session. */
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: goalStatusSchema,
    },
    /** Set/replace the objective (or clear/pause/resume via action). */
    command: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          argument: { type: "string" },
        },
        required: ["sessionID", "argument"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: { schema: goalStatusSchema },
  },
});
