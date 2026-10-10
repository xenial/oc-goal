# oc-goal

Persistent session goals for [OpenCode](https://opencode.ai/), adapted from [Codex's goal feature](https://github.com/openai/codex) (`codex-rs/ext/goal`).

A goal is a durable, per-session objective with a status and an optional token budget. While it is active, oc-goal can continue work across executions using Codex's completion, blocked, and no-progress audit prompts.

## What you get

- **Three model tools** the agent can call:
  - `get_goal` — current goal, status, budgets, token & elapsed-time usage, remaining budget.
  - `create_goal(objective, token_budget?)` — starts a new active goal (only when the user/system explicitly asks; fails if an unfinished goal exists).
  - `update_goal(status)` — the agent may only set `complete`, `blocked`, or `paused`. Resume / budget-limit / usage-limit are system-controlled.
- **Usage accounting** — settled request usage charges uncached input + cache writes + visible output + reasoning. OpenCode's input already excludes cached reads, so they are not subtracted again. Lifetime session totals and title generation are excluded; compaction and budget wrap-up usage are included. Elapsed seconds use a monotonic clock while the goal is being pursued, so system clock adjustments cannot inflate usage. In-flight usage still settles after completion or pause.
- **Automatic continuation** — completion and failure events request continuation at a safe idle boundary with no pending input, without depending on a separate idle notification. Plan mode excludes goal accounting and continuation. A text-only automatic execution suppresses the next continuation until user input or `/goal resume`.
- **Stop and failure handling** — user interruption pauses the goal. Three consecutive empty automatic executions, three consecutive failed command executions without successful tool work, or three identical consecutive execution errors block it. A transient error can retry; quota errors stop it as `usage_limited`.
- **Budget handling** — reaching the budget sets `budget_limited`, publishes the status and sends one wrap-up prompt. An in-flight request or the wrap-up can exceed the budget; it is not a hard provider token limit.
- **A reactive footer** showing status, tokens and elapsed time, including when switching sessions.
- **A `/goal` command** — `/goal <objective>` to set/replace, `/goal status`, `/goal pause`, `/goal resume`, `/goal clear`, and `/goal budget <tokens|none>`.

## Status lifecycle

```
active ──agent: update_goal──► complete        (terminal)
active ──agent: update_goal──► blocked
active ──agent: update_goal──► paused
active ──budget crossed──────► budget_limited  (terminal, takes precedence over pause/block)
active ──usage-limit error───► usage_limited
any non-active ──/goal resume or /goal <new objective>──► active
```

Budget rules adapted from Codex's status semantics:
- Setting `active` while `tokens_used ≥ token_budget` lands on `budget_limited`.
- Lowering the budget below current usage flips `active → budget_limited` immediately.
- `paused`/`blocked` never clobber `budget_limited`.
- Increasing or removing an exhausted budget does not resume work automatically; use `/goal resume` afterward. `budget none` is available only when no maximum is configured.

Pause and clear interrupt current execution. Resume starts a fresh failure audit and continuation count. Repeating the same nonterminal objective preserves its identity and usage; a new objective resets them. Objectives must contain text and be at most 4,000 characters. Changing a running objective steers the current execution. Context hooks reconcile historical or parked continuation prompts with the durable goal state. Status, pause and clear notices do not wake model execution.

## Compared with Codex `/goal`

The plugin follows Codex's goal statuses, tool contract, audit prompts, budget precedence, interruption behavior and continuation guards. OpenCode requires different wiring: usage comes from settled step events, persistence uses plugin key-value storage, steering uses the session inbox, and the footer uses Solid reactivity. It is an adaptation, not an identical implementation of Codex's app-server protocol. The explicit continuation cap and `/goal budget` controls are plugin additions.

Mutations and accounting are serialized per session within the plugin process. The storage adapter has no transactional or cross-process compare-and-swap API, so separate processes sharing the same storage are outside that guarantee.

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
| `enabled` | `true` | Master switch for tools, commands, RPC mutations, accounting and the footer. |
| `maxGoalTokenBudget` | `null` | Positive integer cap and default budget when none is supplied. |
| `maxContinuationTurns` | `0` (unlimited) | Nonnegative integer bound on automatic continuations per run. Reaching it visibly pauses the goal; resume resets the counter. |

## Usage

Set a goal and let the agent pursue it across turns:

```
/goal Migrate the payments module to the new API and make all tests pass
```

The agent works; whenever the session goes idle and the goal is still active, oc-goal dispatches a continuation turn. The agent calls `update_goal` with `complete` when a requirement-by-requirement audit passes, or `blocked` after the same blocker recurs for three consecutive goal turns. Check progress any time with `/goal status`.

## Development

```sh
npm install
npm run verify
```

`src/store.ts` implements persistence and status rules. `src/accounting.ts` tracks usage and failure streaks. `src/runtime.ts` coordinates execution events, inbox guards and controls; `src/index.ts` registers the OpenCode integrations. `src/steering.ts` contains the Codex prompts and the current-state reminder. Tests cover pure logic, the compiled server entrypoint using SDK event shapes, and the compiled footer using Solid's reactive runtime.

## License

MIT
