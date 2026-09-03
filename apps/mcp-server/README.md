# Super Brain MCP server

The stdio MCP server gives any compatible harness the same authenticated memory
search, cited context, candidate proposal, trajectory checkpoint, and memory
feedback tools.

```sh
export SUPER_BRAIN_URL=http://127.0.0.1:3003
export SUPER_BRAIN_WORKSPACE=local-history
export SUPER_BRAIN_TOKEN=replace-harness-token
export SUPER_BRAIN_CAPTURE_URL=http://127.0.0.1:3210
export SUPER_BRAIN_CAPTURE_HOOK_TOKEN=replace-local-hook-token
export SUPER_BRAIN_HARNESS=hermes
export SUPER_BRAIN_SESSION_ID=hermes-session-id

pnpm --filter @_89/super-brain-mcp-server build
pnpm --filter @_89/super-brain-mcp-server start
```

The API token and loopback hook token remain environment variables and are not
accepted as command-line arguments. Recall remains subject to current workspace,
space, creator, and project authorization. Checkpoints contain concise summaries,
not hidden provider chain-of-thought.
