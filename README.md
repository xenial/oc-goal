# oc-goal

Persistent thread goals for [OpenCode](https://opencode.ai/), ported from [codex](https://github.com/openai/codex)'s goal feature (`codex-rs/ext/goal`).

A goal is a durable, per-session objective with a status and an optional token budget. While a goal is `active`, oc-goal automatically continues the session when it goes idle — feeding the model a continuation prompt that keeps it moving toward the objective with completion- and blocked-audit discipline — until the goal is completed, blocked, paused, or runs out of budget.

## What you get

- **Three model tools** the agent can call:
  - `get_goal` — current goal, status, budgets, token & elapsed-time usage, remaining budget.
  - `create_goal(objective, token_budget?)` — starts a new active goal (only when the user/system explicitly asks; fails if an unfinished goal exists).
  - `update_goal(status)` — the agent may only set `complete`, `blocked`, or `paused`. Resume / budget-limit / usage-limit are system-controlled.
- **Usage accounting** — per-turn token delta (`input − cached + output`) and wall-clock seconds are charged to the goal. Crossing the budget flips the goal to `budget_limited` and injects a one-shot wrap-up steering message.
- **Automatic continuation** — on session idle with an active goal, a continuation turn is dispatched with codex's continuation prompt (completion audit, blocked audit, no-progress check, fidelity rules) so the agent keeps working autonomously across turns.
- **Failure handling** — a turn error marks the goal `blocked`; a usage-limit error marks it `usage_limited`; three consecutive empty continuation turns or three consecutive failed exec turns mark it `blocked`.
- **A `/goal` command** — `/goal <objective>` to set/replace, `/goal status`, `/goal pause`, `/goal resume`, `/goal clear`.

## Status lifecycle

```
active ──agent: update_goal──► complete        (terminal)
active ──agent: update_goal──► blocked
active ──agent: update_goal──► paused
active ──budget crossed──────► budget_limited  (terminal, takes precedence over pause/block)
active ──usage-limit error───► usage_limited
any non-active ──/goal resume or /goal <new objective>──► active
```

Budget rules (ported verbatim from codex's SQL semantics):
- Setting `active` while `tokens_used ≥ token_budget` lands on `budget_limited`.
- Lowering the budget below current usage flips `active → budget_limited` immediately.
- `paused`/`blocked` never clobber `budget_limited`.

## Install

```sh
opencode plugin add github:xenial/oc-goal
```

Or configure directly in `opencode.jsonc` (project or `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:xenial/oc-goal",
      "options": {
        "enabled": true,
        "maxGoalTokenBudget": null,
        "maxContinuationTurns": 0
      }
    }
  ]
}
```

### Options

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `maxGoalTokenBudget` | `null` | Cap for any goal's token budget; also the default budget when a goal is created without one. |
| `maxContinuationTurns` | `0` (unlimited) | Safety bound on how many automatic continuation turns a single goal may run. |

## Usage

Set a goal and let the agent pursue it across turns:

```
/goal Migrate the payments module to the new API and make all tests pass
```

The agent works; whenever the session goes idle and the goal is still active, oc-goal dispatches a continuation turn. The agent calls `update_goal` with `complete` when a requirement-by-requirement audit passes, or `blocked` after the same blocker recurs for three consecutive goal turns. Check progress any time with `/goal status`.

## Development

```sh
npm install
npm run build
npm test
```

`src/store.ts` (goal state machine + persistence semantics) and `src/accounting.ts` (per-turn token/wall-clock accounting, empty/exec-failure streaks) are pure logic, ported from codex and unit-tested directly (`test/*.test.mjs`, 45 tests). `src/steering.ts` holds the continuation / budget-limit / objective-updated prompts copied verbatim from `codex-rs/ext/goal/templates/goals/`. `src/index.ts` wires it all into the plugin hooks.

## License

MIT
