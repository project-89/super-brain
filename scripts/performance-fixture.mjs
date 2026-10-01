import { createHash } from 'node:crypto';
import { makeTerminalObservationEvent } from '../packages/fold-activity/dist/index.js';
import * as memory from '../packages/fold-epistemic/dist/index.js';
import { makeTaskEvidenceEvent } from '../packages/fold-trajectory/dist/index.js';
import * as transcript from '../packages/fold-transcript/dist/index.js';

export const SEED = 'fold-performance-history-v1';
export const tenant = { organizationId: 'synthetic-performance-org', workspaceId: 'synthetic-performance-workspace' };
export const access = { ...tenant, principalId: 'principal-0', workspaceRole: 'owner', spaceRoles: Object.fromEntries([0, 1, 2, 3].map(i => [`space-${i}`, 'admin'])) };
export const context = (principal = 'principal-0', audience = 'workspace', spaceId) => ({ access: { ...access, principalId: principal }, author: { kind: 'human', id: principal }, capture: { scope: { workspace: tenant.workspaceId, ...(audience === 'personal' ? { creator: principal } : {}), ...(spaceId ? { space: spaceId } : {}) }, identity: { workspace: tenant.workspaceId, principal } } });
export const uuid = n => `01890f47-7c00-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const stamp = (id, t) => ({ id, t, worldDate: '2026-09-05' });

/** Public synthetic input only. Setup bypasses command overhead, never domain constructors/replay. */
export function performanceFixture() {
  const entries = [], sourceEvents = [], domain = [];
  let serial = 0;
  const next = () => stamp(`perf-${String(++serial).padStart(6, '0')}`, serial * 10);
  const add = event => { entries.push({ status: 'canon', event }); return event; };
  const observation = (index, at) => {
    const s = at ?? next(), principal = `principal-${index % 4}`, project = `project-${index % 81}`;
    const scope = index % 7 === 0 ? { workspace: tenant.workspaceId, space: `space-${index % 4}` } : { workspace: tenant.workspaceId };
    return makeTerminalObservationEvent({ sensor: 'urn:sensor:synthetic-performance', sessionId: `session-${Math.floor(index / 100)}`, heartbeatWindowMs: 30_000, capture: { scope, identity: { workspace: tenant.workspaceId, principal, agent: 'synthetic-agent', task: `task-${index % 100}`, repo: project, branch: 'synthetic', session: `session-${Math.floor(index / 100)}`, project } } }, { id: s.id, t: s.t, observedAt: '2026-09-05T00:00:00.000Z' }, { kind: index % 2 === 0 ? 'prompt_submitted' : 'tool_result', data: { text: `Synthetic ${project} event ${index}: preserve exact revision and delivery order.`, result: 'success', tool: 'synthetic-check' } });
  };
  for (let i = 0; i < 25_000; i++) sourceEvents.push(add(observation(i)));
  const publicSources = sourceEvents.filter(event => event.capture.scope.space === undefined);
  for (let i = 0; i < 81; i++) {
    const project = { id: `project-${i}`, name: `Synthetic project ${i}`, identityKeyHash: digest(`project-${i}`), resolution: 'resolved', roots: [`/synthetic/project-${i}`] };
    const tc = { author: { kind: 'ingest', id: 'synthetic-importer' }, capture: { scope: { workspace: tenant.workspaceId }, identity: { source: 'codex', project: project.id, run: `codex:synthetic-${i}` } } };
    add(transcript.makeTranscriptProjectEvent(tc, next(), project));
    for (let j = 0; j < (i < 41 ? 10 : 9); j++) {
      const runId = `codex:synthetic-${i}-${j}`;
      const artifact = { id: `artifact-${i}-${j}`, source: 'codex', sha256: digest(runId), sourcePathHash: digest(`path-${runId}`), byteLength: 1234, mediaType: 'application/x-ndjson', parser: { id: 'codex-jsonl', version: '1' }, contentPolicy: 'metadata-only', stored: false, redactionCount: 0 };
      const run = { id: runId, nativeId: `synthetic-${i}-${j}`, source: 'codex', artifactId: artifact.id, projectId: project.id, projectResolution: 'resolved', segments: [{ id: `${runId}:segment:0`, ordinal: 0, projectId: project.id, resolution: 'resolved' }], counts: { records: 3, turns: 1, messages: 2, actions: 1, unknown: 0 } };
      const chunk = { runId, sequence: 0, turns: [{ id: `${runId}:turn:0`, ordinal: 0, messageCount: 2, actionCount: 1, roles: ['user', 'assistant'] }], actions: [{ id: `${runId}:action:0`, ordinal: 0, turnId: `${runId}:turn:0`, kind: 'tool-call', name: 'synthetic-check', status: 'completed' }] };
      const rc = { ...tc, capture: { ...tc.capture, identity: { ...tc.capture.identity, run: runId } } };
      add(transcript.makeTranscriptArtifactEvent(rc, next(), artifact)); add(transcript.makeTranscriptRunEvent(rc, next(), run)); add(transcript.makeTranscriptChunkEvent(rc, next(), chunk));
    }
  }
  const memories = [];
  for (let i = 0; i < 1800; i++) {
    const audience = i < 1400 ? 'workspace' : 'personal', principal = i < 1400 ? 'principal-0' : `principal-${i % 4}`, spaceId = i >= 1000 && i < 1400 ? `space-${i % 4}` : undefined;
    const c = context(principal, audience, spaceId);
    const input = { id: uuid(i + 1), audience, ...(spaceId ? { spaceId } : {}), source: 'synthetic-approved', summary: `Revision delivery guidance ${i}`, content: { decision: `Keep revision ${i} exact`, seed: SEED }, applicability: i % 3 === 0 ? { kind: 'global' } : { kind: 'projects', projectIds: [`project-${i % 81}`] }, tags: ['revision', 'delivery'], evidence: [{ eventId: publicSources[i].id }], ...(i >= 200 && i < 230 ? { sourceMemoryRefs: [{ memoryId: uuid(i - 199), revision: 0 }] } : {}), ...(i >= 230 && i < 240 ? { contradicts: [{ memoryId: uuid(i - 199), revision: 0 }] } : {}) };
    const event = add(memory.makeMemoryRecordedEvent(c, next(), input)); domain.push(event);
    memories.push(memory.memoryLogRecordsFromEvent(event)[0].memory);
  }
  for (let i = 0; i < 450; i++) {
    const original = memories[i], revised = add(memory.makeMemoryRevisedEvent(context(), next(), original, { summary: `Corrected revision delivery guidance ${i}` })); domain.push(revised);
    memories[i] = { ...original, summary: `Corrected revision delivery guidance ${i}`, revision: 1, updatedAt: revised.at.t };
    const support = add(memory.makeMemoryEvidenceContributedEvent(context(), next(), memories[i], [{ eventId: publicSources[700 + i].id, ...(i % 10 === 0 ? { relation: 'opposes' } : {}) }])); domain.push(support);
    memories[i] = { ...memories[i], evidence: [...memories[i].evidence, { eventId: publicSources[700 + i].id, ...(i % 10 === 0 ? { relation: 'opposes' } : {}) }], revision: 2, updatedAt: support.at.t };
  }
  for (let i = 0; i < 2500; i++) {
    const proposal = add(memory.makeMemoryCandidateProposedEvent(context(), next(), { id: uuid(10000 + i), audience: 'workspace', source: 'synthetic-extractor', summary: `Candidate revision lesson ${i}`, content: { decision: `Candidate ${i}` }, confidence: 0.5, salience: 0.5, applicability: { kind: 'projects', projectIds: [`project-${i % 81}`] }, evidence: [{ eventId: publicSources[1000 + i].id }], extractor: { kind: 'rule', id: 'synthetic-fixture', version: '1' } })); domain.push(proposal);
    const candidate = memory.memoryCandidateLogRecordsFromEvent(proposal)[0].candidate;
    if (i < 300) {
      const decision = add(memory.makeMemoryCandidateAcceptedEvent(context(), next(), candidate, uuid(20000 + i))); domain.push(decision);
      domain.push(add(memory.makeMemoryRecordedEvent(context(), next(), { id: uuid(20000 + i), audience: 'workspace', source: candidate.source, summary: candidate.summary, content: candidate.content, applicability: candidate.applicability, sourceCandidate: { candidateId: candidate.id, revision: 0, decisionEventId: decision.id } }, [candidate.proposalEventId, decision.id])));
    } else if (i < 1890) domain.push(add(memory.makeMemoryCandidateRejectedEvent(context(), next(), candidate, 'Synthetic reviewer rejected')));
  }
  for (let i = 0; i < 100; i++) {
    const taskId = `task-${i}`, attemptId = `attempt-${i}`, revisionId = `revision-${i}`;
    add(makeTaskEvidenceEvent(context(), next(), { recordType: 'task-manifest', input: { version: 1, taskId, taskVersion: 'v1', goal: 'Synthetic revision delivery check', acceptanceCriteria: [{ id: 'exact-delivery', description: 'No missing or repeated source occurrence' }] } }));
    add(makeTaskEvidenceEvent(context(), next(), { recordType: 'attempt-manifest', input: { version: 1, taskId, taskVersion: 'v1', attemptId, startRevision: { fingerprintStatus: 'available', revisionId }, finalRevision: { fingerprintStatus: 'available', revisionId } } }));
    add(makeTaskEvidenceEvent(context(), next(), { recordType: 'outcome', authority: { kind: 'human', principalId: access.principalId }, input: { version: 1, id: `outcome-${i}`, taskId, attemptId, revisionId, kind: 'check', result: i % 5 === 0 ? 'failure' : 'success', observedAt: '2026-09-05T00:00:00.000Z', sourceEventId: publicSources[1500 + i].id } }));
  }
  for (let i = 0; i < 1500; i++) domain.push(add(memory.makeMemoryFeedbackEvent(context(), next(), memories[i % 300], { version: 2, memoryRevision: memories[i % 300].revision, recallId: `synthetic-recall-${i}`, signal: i % 3 === 0 ? 'judged' : 'offered', ...(i % 3 === 0 ? { judgment: i % 7 === 0 ? 'unhelpful' : 'helpful' } : {}) })));
  for (let i = 280; i < 290; i++) domain.push(add(memory.makeMemoryForgottenEvent(context(), next(), memories[i], 'Synthetic forgotten source')));
  while (entries.length < 39_900) add(observation(serial));
  // Delayed delivery appears at the ingestion tail but belongs earlier in canonical time.
  for (let i = 0; i < 100; i++) add(observation(i + 40000, stamp(`perf-late-${String(i).padStart(3, '0')}`, 5 + i * 20)));
  const projection = memory.rebuildMemories(entries.map(({ event }) => event));
  memory.rebuildMemoryCandidates(entries.map(({ event }) => event));
  transcript.rebuildTranscriptCatalog(entries.map(({ event }) => event));
  const encoded = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  return { entries, encoded, metadata: { seed: SEED, sha256: digest(encoded), eventCount: entries.length, bytes: Buffer.byteLength(encoded), kinds: Object.fromEntries([...new Set(entries.map(({ event }) => event.kind))].sort().map(kind => [kind, entries.filter(({ event }) => event.kind === kind).length])), activeMemories: projection.memories.size, forgotten: projection.forgotten.size, lateArrivals: 100, principals: 4, projects: 81, spaces: 4 } };
}
