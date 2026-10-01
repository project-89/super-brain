# Typed decision models for Fold

Research note, updated 2026-09-24. This records architectural candidates, not
an integrated provider or a measured result on Super Brain data. Jev account
creation is unavailable to us, so the runnable pilot must use open local models.

## What the models do

TypeSafe's hosted Jev takes a `state` and independent typed questions. `Choice`
returns a distribution over named options, `Score` returns a distribution over
ordered rubric levels, and `Noul` returns a yes probability. The model does not
generate explanations, citations, code, or new text. Code must build the state,
define the answer space, apply policy, and decide what to do with each answer.
Questions in one Jev request share the state and run independently. Its current
versioned model is `jev-1.13.0`; its documented limit is 64k tokens total and
32k for the state plus longest question. Pin the version when evaluating or
tuning thresholds instead of using the moving `jev-latest` alias.

Laya is a separate open-weight implementation of the same *kind* of interface,
not Jev's weights or a Jev runtime. It uses a bidirectional encoder and decision
heads rather than token-by-token text generation. `laya-mlx` independently ports
Laya inference to Apple's MLX. The English checkpoints use ModernBERT-large
(421M parameters); the multilingual checkpoint uses mmBERT-base (322M). Their
context limits are 512 or 1,024 tokens **including questions and choices**.
Each Laya question is encoded with the state; a batch does not reuse a single
state representation across arbitrary questions.

| Dimension | Hosted Jev | Local Laya MLX |
| --- | --- | --- |
| Model and deployment | Proprietary TypeSafe API | Open-weight Laya checkpoint, independent MLX port, Apple Silicon only |
| Input budget | 32k state plus longest question; 64k request | 512 or 1,024 tokens per question row |
| Output | Choice, Score, Noul with probabilities | Compatible typed primitives and probabilities |
| Domain adaptation | Question/state design; no customer fine-tune | Upstream provides training and a specialized typed-decisions checkpoint; MLX port is inference/conversion |
| Data path | Authorized evidence leaves our boundary for an API | Evidence stays on the local machine hosting the sidecar |
| Suitable first role | Longer, richer semantic judgments | Short, frequent, privacy-sensitive judgments with tightly selected evidence |

The Laya MLX README advertises 13.42 ms for a short English question and 7.39
ms for its multilingual checkpoint on an M3 Max. Its linked `BENCHMARKS.md`
currently reports 17.75 ms and 10.91 ms respectively for the short one-question
FP16 rows. Treat this as a publication discrepancy to resolve before quoting
one figure as definitive. That benchmark excludes model load/download, uses a
single M3 Max, and its 50-question rows repeat three templates with a batch size
of 64 instead of the API default 16. Full-context one-question FP16 rows take
49.84 ms (English) or 43.50 ms (multilingual). These measurements compare MLX
with upstream PyTorch on the same Mac; they do **not** compare Jev with Laya or
predict Fold's capture-to-result latency. The port's 63/63 selected-answer
agreement per checkpoint/precision demonstrates port fidelity on fixtures, not
semantic accuracy on our tasks.

Neither a well-formed output nor high confidence proves a judgment correct.
Choice/Score `confidence` is computed from the distribution; Noul does not have
that field. TypeSafe documents literal readings, numeric/date errors, weak
performance on irrelevant long state, adversarial content, and failures of
expected probability identities between differently worded questions. Laya MLX
also clamps a checkpoint calibration bucket for choices with 11+ options because
its raw temperature would turn a near tie into apparent certainty. Our gates
must be calibrated separately for each model, version, question, and action.
In particular, Laya's published mean ECE improvement from 0.466 to 0.081 is
after **domain temperature fitting** on held-out data; it is not a portable
calibration guarantee for Fold. Upstream reports its general English and
multilingual checkpoints below a majority-class baseline on the specialized
typed-decisions benchmark, while the fine-tuned checkpoint performs much
better on that benchmark's test split. This makes our own labeled task sample
essential before treating the fast base model as a useful trajectory mapper.

Sources: [TypeSafe introduction](https://docs.typesafe.ai/introduction),
[Jev models](https://docs.typesafe.ai/models),
[confidence](https://docs.typesafe.ai/confidence),
[documented Jev failure modes](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[Laya upstream](https://github.com/NandhaKishorM/laya),
[Laya MLX README](https://github.com/mizorewww/laya-mlx),
[Laya MLX benchmark method and raw-result links](https://github.com/mizorewww/laya-mlx/blob/main/BENCHMARKS.md),
[Laya upstream calibration and task benchmark](https://github.com/NandhaKishorM/laya).

## Runnable open shortlist

These projects share an interface idea, not a common architecture, dataset,
calibration method, or quality level. Public benchmark numbers from different
projects cannot establish a winner for Fold.

| Candidate | Verified release and useful distinction | Fold pilot role |
| --- | --- | --- |
| [Laya MLX](https://github.com/mizorewww/laya-mlx) | Dedicated encoder and decision heads, open weights, short context, native Apple MLX | First short-step projection and stream-triage candidate |
| [Decider 2B](https://github.com/Mapika/decider) | Qwen3.5 model with typed answer slots, released weights, 32k serving context, Apple MPS support and optional Metal kernel; its hard-item calibration is a documented weakness | Longer-context local candidate when the evidence cannot fit Laya's window |
| [Kev 4B](https://github.com/jaredpalmer/kev) | Current Qwen3.5 family, released weights and evaluation data, local MLX and a System One-compatible HTTP server; supports domain fine-tuning | Stronger-model challenger for difficult mappings and an easy provider-adapter target |
| [SemIf](https://github.com/TheoLeeCJ/SemIf-OpenJev) | Open model option-logit readout with MLX, MPS, CUDA and GGUF paths; published frozen fixtures and explicit calibration experiments | Untuned open-model baseline, especially for shared-state question batches |
| [CLM 8B](https://github.com/Contrastive-LM/CLM) | Contrastively trained state/action encoders with reusable action embeddings and a typed-decision/ranking API; reference server requires an NVIDIA GPU | Separate GPU evaluation lane for node matching and best-of-N reranking |

The list supplied to us describes Kev as a Qwen2.5 0.5B model. That checkpoint
exists, but its maintainers now mark it superseded by the 0.8B, 4B and 9B
Qwen3.5 family. Kev's current serving limit is 8,192 tokens per branch, while
its training examples used at most 384 state tokens and 1,024 tokens per
question branch. Its reported M5 median for a new ~270-token state and five
questions is 721 ms for the 4B model. This makes it a possible quality challenger,
not a presumed low-latency replacement for Laya. Decider's 2B MPS benchmark is
133 ms median for three smoke workloads on an M1 Pro; that is likewise not a
Fold result or a controlled cross-project comparison.

Other released projects are worth tracking without making the first pilot wider:
[Jeff](https://github.com/logan-markewich/jeff) provides a convenient local
System One-style endpoint, but its own comparison reports weaker results on
reasoning-heavy tasks and says Choice/Score questions can affect each other
unless full isolation is enabled. [NanoJev](https://github.com/TianyuCodings/NanoJev)
publishes code, weights and data, but its current checkpoint and held-out
evidence concentrate on Maze, Snake and ViZDoom actions rather than agent-trace
alignment. [Nimble](https://github.com/bespokelabsai/nimble) has a 9B local MLX
path and interesting contrastive data curation, but its 2,048-token input and
larger local footprint make it a later challenger. [Rizzo Flow](https://github.com/Rizzo-AI-Academy/rizzo-flow)
and the other interface wrappers may be useful implementation references; an
HTTP-compatible endpoint alone does not demonstrate equivalent judgments.

For every contender, verify the exact checkpoint, weight license, state/question
format, abstention behavior, option-order stability, calibration on our labels,
local memory, and end-to-end latency. A single provider-neutral request/response
contract in the Fold sidecar should keep the projection and worker logic
independent of these backends.

### CLM: state and action alignment

[CLM](https://github.com/Contrastive-LM/CLM) is particularly relevant to a
Fold tree. Its frozen Qwen3-8B backbone produces last-token embeddings; separate
trainable projection heads map the **state plus question** and each candidate
**action description** into a shared space. Training pulls matched pairs together
and pushes alternatives apart with a bidirectional contrastive loss. The released
recipe includes roughly 60M question/answer pairs, 30M synthetic hard negatives,
and 1M agent trajectories. Released code and [base head weights](https://huggingface.co/Contrastive-LM/CLM-v0.1-8B)
are Apache 2.0. This is a different architecture and training target from Laya's
typed decision heads or the Qwen option-logit projects.

One Fold step can be the state; the retrieved, independently defined tree nodes
can be candidate actions. Stable node descriptions can have their embeddings
cached across many events, making a large candidate set cheaper after the first
encoding. A fresh state/question still requires a Qwen3-8B embedding, and a
changed question changes that embedding. CLM also exposes `rank`, which could
order candidate evidence, tools, or several completed attempts for review. Its
`choice`, `score`, and `noul` endpoints can fit the same sidecar contract, though
adapter tests must check exact semantics rather than assuming Jev equivalence.

The reported probabilities are a softmax **over the supplied candidates**. A
high value can mean only that one poor option beats the other poor options. Add
an explicit `none/unmapped` candidate and assess a separate abstention gate on
independent Fold labels. The API's `confidence` is distribution spread (top
probability minus the mean of the rest), not measured correctness. Candidate
wording, added options, and shortlist quality can change every probability.
For a Fold *outcome* or verifier use, require independent acceptance evidence;
reranking plausible completions does not establish that any completion passed.

The repository's zero-shot task results and up-to-9x latency claim are
self-published system comparisons, with varying success rates. Its 81.6%
DeepSWE figure is **31 of 38 best-of-four selections** using a fine-tuned
[verifier head](https://huggingface.co/Contrastive-LM/deepswe-clm-heads-8k),
versus 28 of 38 pass@1 and 34 of 38 oracle. It measures selection among sampled
solutions, not generation or a general ability to judge Fold outcomes. The
reference deployment is Linux/NVIDIA, with a vLLM pooling service plus a
separate CLM API. Its default 2,048-token encoder limit and truncation setting
mean the adapter must reject or deliberately summarize oversized states rather
than silently losing the end of a stream event. There is no documented Apple
Silicon path in this release. The current M2 Max pilot therefore starts with
the MLX/MPS shortlist; run CLM as a distinct GPU challenger when a suitable,
authorized host and representative evaluation batch are available. Record GPU
transport, cache hit rate, batching, and full event-to-answer latency, since
cached-action benchmark speed may not transfer to fresh Fold states.

## Where the pattern fits Super Brain

1. **Trajectory projection proposals.** For a short captured step, retrieve the
   independently authored task tree and construct a bounded state with the step,
   nearby causal evidence, current node, and a small set of candidate node IDs
   with plain-language definitions. A Choice can rank candidates. A separate
   Noul can ask whether *any* candidate actually describes the step. Keep the
   exact model output and candidate list as a proposal. Convert it to the
   existing `mapped`, `ambiguous`, or `unmapped` assignment only under a
   task-calibrated policy; review uncertain or consequential mappings. The
   `ProjectionMethod` already supports `kind: "model"`, `id`, and `confidence`.
   The current self-mapping fixture is structural, so a new model must be
   compared against independent annotations before it contributes to claims of
   semantic alignment. Never use a suggested node as its own ground truth.

2. **Asynchronous stream triage.** A durable consumer can classify *authorized,
   redacted, content-bearing* events for relevance, possible contradiction,
   intervention need, or which specialist worker should inspect them. The model
   would process a bounded window after capture, then write versioned derived
   proposals with source event IDs, evidence digests, scope, question version,
   checkpoint/model version, complete probabilities, and processing status.
   Advance the consumer cursor only after a durable job receipt; retries must
   be idempotent. Recheck scope and source freshness before publishing. This
   follows the existing memory worker's durable job and reauthorization pattern.
   Stream classification should not alter canonical source events or silently
   promote a memory, episode, outcome, or trajectory verdict.

3. **Candidate relevance and retrieval.** After access filtering and an
   inexpensive lexical/embedding shortlist, ask whether each candidate is
   useful for a concrete query or task. This is a reranking feature, not a
   substitute for authorization or provenance. Benchmark it against the
   current local BM25 ranker and the existing retrieval evaluation set before
   making it a default.

4. **Quality signals.** Narrow checks can flag possible stale advice,
   contradictions, missing acceptance evidence, or a likely wrong citation for
   deeper review. A generative reasoner is still needed to synthesize episodes,
   write explanations, propose new tree structure, and produce cited claims;
   deterministic code still owns exact counts, dates, access control, schema
   validation, and confirmed outcomes.

The strongest first use is **step-to-node suggestion**, since its labels are
already defined in a tree and the projection contract preserves ambiguity.
The strongest stream use is **triage of which evidence deserves expensive
reasoning**, because a false negative can be retained and audited rather than
silently dropping source evidence.

## Small empirical pilot

1. Freeze one real task, starting commit, shared tree, and a sample of steps
   from at least two materially different agent runs. Independently annotate
   each step `mapped`, `ambiguous`, or `unmapped`, including candidate nodes and
   evidence. Add deliberate negatives, overlapping labels, long/noisy steps,
   and adversarial text from tools. Keep annotations separate from model output.
2. Build one deterministic, scope-aware candidate selector and state formatter.
   Start with Laya MLX, Decider 2B, and Kev 4B; use SemIf as an untuned baseline
   if the fixture budget allows. Give each model the same *information* and
   question semantics, recording any truncation or changed candidate shortlist.
   Compare Laya's general and specialized typed-decisions checkpoints; do not
   assume the specialized checkpoint transfers to our trajectories. Run CLM on
   the same frozen batch as a separate GPU lane when hardware is available;
   measure both cold and cached candidate descriptions.
3. Run a shadow batch, with no automatic publication. Record selected label,
   every probability, version/hash of state and questions, candidate set,
   truncation, latency including sidecar/API transport, errors, cost, memory,
   and per-scope processing lag. Preserve raw-source linkage without exporting
   private transcript bodies in the evaluation report.
4. Report mapping agreement, ambiguous/unmapped recall, false confident maps,
   calibration (Brier/ECE or reliability plot), and **coverage versus error**
   across proposed thresholds. Also report downstream route/first-divergence
   changes and how often human review is needed. Break out each agent model and
   question type so aggregate accuracy does not hide a weak subgroup.
5. Promote only if the chosen model improves useful coverage at an acceptable
   false-map rate and processing lag, with no scope or provenance regression.
   Start with proposals for review; automation thresholds must come from this
   pilot, not from a vendor example.

Current local host is Apple M2 Max, so published M3/M5 and CUDA latency numbers
do not transfer directly. This note does not claim a live provider comparison or
a local model benchmark. Jev can be a historical reference if access returns,
but it is not a dependency of the pilot.
