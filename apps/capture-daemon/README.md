# Super Brain Capture Daemon

The capture daemon is a headless, harness-neutral local sensor. Claude Code,
Codex, and other harnesses can POST lifecycle and tool hooks to its loopback-only
HTTP listener. Every accepted hook is secret-redacted into a private artifact
vault and its canonical events are durably spooled before delivery to Super Brain.

It captures session/project identity, prompts as private artifact references,
tool calls and outcomes, relative file changes, test/build/lint verification,
structured reasoning checkpoints, human decisions, session trajectories, and a
stable transcript import after `SessionEnd`. It does not claim success when no
verification or explicit verdict was observed.

Raw exposed reasoning is excluded from transcript artifacts by default. With
explicit opt-in, the daemon stores complete incremental transcript deltas in the
private encrypted/redacted vault and adds exposed summaries to periodic
canonical reasoning trees. Opaque provider reasoning has a separate retention
switch; it is preserved as evidence but cannot be decrypted by Super Brain.

New configurations encrypt redacted vault artifacts with a separate AES-256-GCM
key. Existing configurations can enable future encrypted writes with
`enable-vault-encryption`, followed by a daemon restart.

```sh
SUPER_BRAIN_CAPTURE_TOKEN=... super-brain-capture init
super-brain-capture install-hooks
super-brain-capture install-service
super-brain-capture status
```

Capture settings can be changed from the Brain settings dialog with the
dedicated operator token or from the CLI. Configuration changes restart the
installed service:

```sh
super-brain-capture configure --reasoning include \
  --encrypted-reasoning retain --reasoning-trees summaries \
  --tree-every 25 --anonymize none
super-brain-capture rotate-operator-token
super-brain-capture install-service
```

`--anonymize pseudonymous` retains stable keyed joins while hiding identity and
absolute-path segments. `strict` also obscures full paths, URLs, and IP
addresses. Secret redaction always runs, including in `none` mode. A zero tree
interval disables periodic snapshots without changing finalization.

Reading exposed local reasoning is an explicit terminal action:

```sh
super-brain-capture inspect-reasoning --session SESSION_ID --limit 100 --confirm
```

Integrity-manifest exports use `SUPER_BRAIN_EXPORT_TOKEN` when the capture
sensor credential is intentionally write-only. Raw-hook retention is dry-run by
default and never removes canonical events or redacted transcript artifacts.
Quarantined permanent failures can be reviewed with `retry-failed` and returned
to the durable delivery queue only with `retry-failed --confirm` after their
underlying compatibility or authorization issue has been corrected. If newer
events already made the original timestamp impossible to append, use the
additional explicit `--rebase-events`; the reissued event retains its original
ID in capture identity.

Agents can publish deliberate, concise reasoning and operator verdicts without
exposing private transcript content:

```sh
printf '%s' '{"session_id":"...","summary":"Cache invalidation is the leading hypothesis","evidence":"Focused test fails before refresh"}' \
  | super-brain-capture checkpoint codex

printf '%s' '{"session_id":"...","summary":"Operator accepted the verified result","verdict":"success","confidence":1}' \
  | super-brain-capture decision codex
```
