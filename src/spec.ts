/**
 * Tool specifications, descriptions verbatim from codex `ext/goal/src/spec.rs`.
 */

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";

export const GET_GOAL_DESCRIPTION =
  "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.";

export const CREATE_GOAL_DESCRIPTION = `Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.
Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use ${UPDATE_GOAL_TOOL_NAME} only for status.`;

export const UPDATE_GOAL_DESCRIPTION = `Update the existing goal.
Set status to \`paused\` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.
Set status to \`complete\` only when the objective has actually been achieved and no required work remains.
Set status to \`blocked\` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic goal continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked \`blocked\`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to \`blocked\` again.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to \`blocked\`.
Do not use \`blocked\` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.
When marking a budgeted goal achieved with status \`complete\`, report the final token usage from the tool result to the user.`;

export const OBJECTIVE_PARAM_DESCRIPTION =
  "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.";

export const TOKEN_BUDGET_PARAM_DESCRIPTION =
  "Positive token budget for the new goal. Omit unless explicitly requested.";

export const UPDATE_STATUS_PARAM_DESCRIPTION =
  "Required. `paused` requires an explicit user request. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.";

export const COMPLETION_BUDGET_REPORT =
  "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language.";

export const UPDATE_GOAL_STATUS_ERROR =
  "update_goal can only mark the existing goal complete, blocked, or paused at the user's explicit request; resume, budget-limited, and usage-limited status changes are controlled by the user or system";

export const CREATE_GOAL_CONFLICT_ERROR =
  "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first";

export const NO_GOAL_ERROR = "cannot update goal because this thread has no goal";
