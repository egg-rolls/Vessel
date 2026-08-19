# Vessel CLI Commands

Vessel has two command surfaces:

- REPL slash commands are interactive and begin with `/`.
- Process options are passed to `src/cli.ts` and are intended for scripts.

## REPL asset commands

| Command | Purpose |
| --- | --- |
| `/sessions` | Browse, resume, inspect history, and delete sessions |
| `/assets` | Show the asset overview |
| `/tools` | Browse registered tools and input schemas |
| `/plugins` | Browse loaded plugins |
| `/mcp` | Browse MCP servers; `C` reconnects, `T` tests, `D` disconnects |
| `/skills` | Browse discovered skills |

All browsers support `↑/↓`, `Enter`, `R`, `?`, and `Esc`. Destructive session
deletion requires pressing `D` twice. The MCP browser only operates on
servers declared in the current configuration.

## Process options

```text
bun run src/cli.ts
bun run src/cli.ts --run "prompt"
bun run src/cli.ts --session <id> --run "prompt"
echo "prompt" | bun run src/cli.ts --run
bun run src/cli.ts --sse-port 3333
```

`--run` is the headless entry point. `--session` selects the session used by
that run. `--help` prints the complete option list.

