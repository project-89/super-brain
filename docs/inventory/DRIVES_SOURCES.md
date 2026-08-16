# Drives Source Inventory

Audited on 2026-08-16. The source worktree was read-only and clean. Its current
HEAD was `bfdf99aa87459e34db86c627e9fcf7d195a4a0fa`, but extraction used only the
manifest-pinned commit below.

## Embers Baseline

- Repository: `/Users/jakobgrant/Workspaces/embersjs`
- Origin: `git@github.com:HaruHunab1320/embersjs.git`
- Pinned commit: `1bbafe059809026447f361d0e9f4a0e44e161ee9`
- Commit subject: `feat: pursuable drives and surfacing eligibility`
- License: MIT (`LICENSE` present at the pinned commit)
- Package at the baseline: `@embersjs/core` 0.2.0

## Contract Map

| Source | Inspected contract | Local destination |
| --- | --- | --- |
| `docs/design/v0.3/intention.md` | Three-state intention model; fold discrete state, sample continuous state; exact incremental replay constraint | Package boundary and parity cases |
| `src/drives/drift.ts` | Linear, exponential, and custom stepwise drift with per-step `[0,1]` clamping | `src/state.ts`: `applyDrift` |
| `src/drives/satiate.ts` | Kind/type/predicate matching, additive binding amounts, applied clamping, requested amount | `src/state.ts`: `integrateDriveEntry` |
| `src/drives/query.ts`, `src/metabolism/pressure.ts` | Raw and weighted pressure; descending structured summaries | `src/state.ts`: pressure and summary queries |
| `src/wear/{config,query,tick}.ts` | Strict threshold zones, hysteresis, post-drift accrual, asymmetric recovery, tier-weighted chronic load | `src/state.ts`: wear projection |
| `src/being/{history,lifecycle}.ts` | Satiation and wear discontinuities; operation-time attribution; sampled trajectory | Domain results and canonical event constructors |
| `src/intentions/core.ts` | Surfaced, committed, declined, acted, ended lifecycle; max-three cap; urgency from current pressure, age, and attempts | `src/intentions.ts`: Fold-event replay and queries |
| `src/intentions/eligibility.ts` | Threshold signal, live-pair suppression, decline cooldown, structural satisfier identity | `src/intentions.ts`: `eligibleToSurface` |
| `src/metabolism/metabolize.ts` | Structured drive state is the deliverable; prose is optional host policy | `summarizeDrives`; prose excluded |

## Parity Evidence

The local tests retain these load-bearing cases from the pinned source:

- the exact 48-hour hourly decline and `19/24` chronic load;
- incremental and one-step 30-hour advances landing on opposite sides of `0.2`;
- satiation and drift not commuting near the clamp;
- wear using post-drift levels and recovering asymmetrically;
- unclamped requested satiation remaining visible;
- complete intention replay, live commitment cap, action-count urgency decay,
  and terminal reason records;
- threshold eligibility, live-pair suppression, and decline cooldown.

## Local Adaptation

Super Brain owns all types and APIs. Operations return new state rather than
mutating an Embers `Being`. Discrete records use canonical Fold 0.7 events and
mandatory actor capture identity. Intention replay sorts by Fold event keys and
fails closed when origins or lifecycle transitions are invalid.

Drive level is intentionally not reconstructed from sparse discontinuity
events. `DriveSystemSnapshot` is the boot boundary; advancing after restoration
must use the original tick sequence. This preserves the pinned threshold result
instead of pretending a closed-form calculation is equivalent.

Excluded: practices, capabilities, attention weighting, self-model assembly,
felt prose, default voice, mutable being serialization, ring-buffer policy, and
all host cognition or actuation.
