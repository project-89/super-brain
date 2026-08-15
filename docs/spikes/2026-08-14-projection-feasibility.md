# Cross-Model Projection Feasibility Spike

**Date:** 2026-08-14  
**Status:** structural fixture passed; empirical feasibility remains open.

## Question

Can heterogeneous traces be represented on a shared decision structure without
erasing the information needed to explain divergence?

## Experiment

One hand-built task models a refresh-token regression. Two deliberately
different fixture trajectories are projected onto one shared tree:

- model A attributes the 401 to token expiry, patches refresh handling, and
  succeeds;
- model B attributes the 401 to network instability, adds a retry, and fails.

The model names and steps are synthetic. This experiment tests the representation
and algorithms only; it is not evidence about real model behavior or projection
accuracy.

Model B also contains one genuinely ambiguous search step and one explanatory
step with no matching decision node. Both remain explicit in the projected
trace.

## Result

The representation survives this fixture:

- raw step content, model identity, and capture scope remain attached;
- projection has three outcomes: `mapped`, `ambiguous`, and `unmapped`;
- every outcome records its projection method and optional confidence;
- aggregation counts only edges between adjacent mapped steps and never bridges
  a projection gap;
- incomplete traces remain useful for edge evidence but are excluded from
  whole-route consensus;
- first-divergent-edge finds model B's network branch before its later gaps;
- an ambiguity before the branch returns `indeterminate` instead of guessing.

Fixture coverage is 10 mapped, 1 ambiguous, and 1 unmapped step across 12 total.
Only one of the two traces is eligible for whole-route aggregation, which is
reported explicitly.

## Freeze-Gate Consequences

The minimum production contract needs all of the following:

1. raw steps are immutable and retained beside projections;
2. projection outcome and projection method are separate fields;
3. ambiguity candidates and unmapped reasons are first-class data;
4. edge aggregation cannot bridge gaps;
5. projection coverage and route eligibility accompany every analysis;
6. identity and capture scope survive projection losslessly;
7. first divergence may be `indeterminate` and consumers must display that state.

## Remaining Bet

This does not prove that a general projector can map real, heterogeneous model
traces with useful coverage. The next empirical run needs one concrete task and
two captured model trajectories with tool results and outcome labels. The same
fixture must then be replaced or supplemented without changing the contract. A
low mapped ratio or frequent pre-divergence ambiguity would force a different
shared-tree representation before `fold-trace` freezes.

