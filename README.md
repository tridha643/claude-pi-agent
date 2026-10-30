# pi-agent

A Claude Code mod that runs the [pi](https://github.com/earendil-works/pi) coding agent as a native subagent. Claude delegates with `Agent({ subagent_type: "pi-agent:pi" })`, the task gets a normal row in the tasks list, and its transcript view streams pi's text and tool calls live. No Claude model is involved: the mod answers the subagent's model requests by running `pi -p --mode json` and streaming its output back, so the row shows `pi/gpt-6-astra`.

Follow-ups (SendMessage, or typing in the agent's view) continue the same pi session, keyed by the agent's id.

pi runs its own read/bash/edit/write tools in the session's directory, without Claude Code's permission prompts.

## Requirements

- `pi` on your `PATH`, signed in to a provider that serves the model in `hooks/register.ts` (`MODEL`, default `openai/gpt-6-astra`). Check with `pi --list-models`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pi-agent --marketplace tridha643/claude-pi-agent
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install pi-agent --marketplace tridha643/claude-pi-agent
```

## How it works

1. `session.start` registers the agent type `pi-agent:pi`.
2. `turn.start` tags turns whose agent is that type.
3. `turn.step` for a tagged turn never calls the model: it spawns pi with the prompt on stdin and `--session-id <agentId>`, and yields pi's JSON events as the response text.
4. A stop chunk ends the turn, and the text goes back to Claude as the Agent tool's result.
