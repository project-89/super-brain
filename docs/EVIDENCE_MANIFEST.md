# Evidence Manifest

Observed on 2026-08-14. Referenced repositories were treated as read-only. The
`dirty files` column records the number of porcelain-status entries at the time
of inspection; it is a warning that the commit alone may not describe every file
that was read.

| Repository | Branch | Commit | Origin | Dirty files |
| --- | --- | --- | --- | ---: |
| confidence-kernel | main | `aa86bf8b27fbcbba2f6c4c2ce109deefa28ad402` | `git@github.com:project-89/confidence-kernel.git` | 1 |
| mythopia | main | `c9fc2c68b8f76e6b2ec8f65901d2396496d0c40b` | `git@github.com:HaruHunab1320/mythopia.git` | 1 |
| embersjs | main | `1bbafe059809026447f361d0e9f4a0e44e161ee9` | `git@github.com:HaruHunab1320/embersjs.git` | 0 |
| decision-pathfinder | main | `5ceb7e36b128736bd336d5b0afce9ad4befa8152` | `git@github.com:HaruHunab1320/decision-pathfinder.git` | 1 |
| reasoning-tree | main | `e517359966b4310f0c0f00f1a4c94a2da4d6d66a` | `git@github.com:project-89/reasoning-tree.git` | 1 |
| parallax | main | `e3c98ebba4b3e29959325f2f974cee27c32a24a6` | `git@github.com:HaruHunab1320/parallax.git` | 2 |
| raven-docs | main | `817d7541868cc7947b004b4f59c48da8145f2419` | `git@github.com:HaruHunab1320/raven-docs.git` | 2 |
| narrative-canon | main | `48e0add343cbd4e0433274ba8d437f9e551338a3` | `git@github.com:project-89/narrative-canon.git` | 1 |
| hauntjs | main | `4c675c63cbbf870b34fd9fed48b26f58e2b9eed1` | `git@github.com:HaruHunab1320/hauntjs.git` | 2 |
| tmux-manager | main | `d5fd340b3de33957e0ecb016b1f2738ded386267` | `git@github.com:HaruHunab1320/tmux-manager.git` | 1 |
| pty-state-capture | main | `29bbff378ac51dbfb0197b26022bb9aa383f0bb2` | `git@github.com:HaruHunab1320/pty-state-capture.git` | 1 |

## Vendored Baseline

`docs/spec/reference/CHANGE_RECORD_SPEC_v0.6.md` is byte-identical to
`narrative-canon/docs/CHANGE_RECORD_SPEC.md` as observed at the baseline above.

- SHA-256: `eb2f8c03a8839bf05ce28af8178b88f66b47a0b5429526aeffa619932b48f5c0`
- The file is retained as evidence and must not be edited.
- v0.7 changes live in `docs/spec/CHANGE_RECORD_SPEC_v0.7_AMENDMENTS.md`.

## Imported Package

`packages/confidence-kernel/src`, `test`, `README.md`, and `LICENSE` are
byte-identical to the tracked files from confidence-kernel commit
`aa86bf8b27fbcbba2f6c4c2ce109deefa28ad402` (package 0.2.0). The repository's
single dirty entry was the untracked `REPORT_KERNEL.md`; it was not imported.
Workspace-owned build metadata and the full record of excluded files live in
`packages/confidence-kernel/PROVENANCE.md`.

`packages/fold-narrative/test/fixtures/mythopia/fellowship-reference-canon.yaml`
is byte-identical to Mythopia's tracked fixture at commit
`c9fc2c68b8f76e6b2ec8f65901d2396496d0c40b`. It is private, test-only parity
evidence from an `UNLICENSED` repository and is excluded from the package file
set. Its provenance record is colocated with the fixture.

`packages/fold-storage` reimplements the complete-line JSONL append and offline
replay behavior inspected in pty-state-capture commit
`29bbff378ac51dbfb0197b26022bb9aa383f0bb2`. No source file was copied. Its
package-level provenance record lists the inspected files and the stricter local
behavior added for Fold.
