// Only synthetic state is created. This fixture never reads checkout .env files or live capture configuration.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { FoldSdk } from "../../../packages/fold-sdk/dist/index.js";
import { makeTerminalObservationEvent } from "../../../packages/fold-activity/dist/index.js";
import { createApiServer, StaticIdentityDirectory } from "../../api/dist/index.js";
import { SuperBrainClient, nextEventStamp, uuidV7 } from "../../../packages/super-brain-client/dist/index.js";
import { CaptureEngine, CaptureHttpServer, CaptureReceiptQueue, DurableSpool, HookVault, StateStore, parseCaptureConfig, receiptEncryptionKey } from "../../capture-daemon/dist/index.js";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "super-brain-ui-fixture-"));
const organizationId = "local", workspaceId = "fixture-workspace", sensorId = "urn:sensor:fixture-capture";
const apiToken = "fixture-owner", operatorToken = "fixture-operator";
const entries = [];
const sdk = new FoldSdk({ async read() { return { entries: [...entries] }; }, async append(entry) { entries.push(entry); } });
const identities = new StaticIdentityDirectory({
  [apiToken]: { principalId: "fixture-owner", taskEvidenceAuthority: { kind: "human" }, author: { kind: "human", id: "fixture-owner" }, workspaces: { [workspaceId]: { role: "admin" } } },
  "fixture-sensor": { principalId: "fixture-sensor", author: { kind: "sensor", id: sensorId }, workspaces: { [workspaceId]: { role: "member" } } },
  "fixture-reader": { principalId: "fixture-reader", capabilities: ["memories:read", "events:read", "trajectories:read", "transcripts:read", "fleet:read", "steering:read", "reasoning:read"], workspaces: { [workspaceId]: { role: "member" } } },
});
const api = createApiServer({ authenticator: identities, memberships: identities, sdks: { sdkFor: async () => sdk } });
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;
const client = new SuperBrainClient({ baseUrl: apiUrl, organizationId, workspaceId, token: apiToken });
const machine = new SuperBrainClient({ baseUrl: apiUrl, organizationId, workspaceId, token: "fixture-sensor" });
const repository = join(temporary, "repository"); await mkdir(repository);
const git = (...args) => execFileSync("git", ["-C", repository, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
git("init", "-q"); await writeFile(join(repository, "release.txt"), "Synthetic release fixture\n"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture baseline");
const keyFile = join(temporary, "vault.key"); await writeFile(keyFile, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), { mode: 0o600 });
const statusFile = join(temporary, "processing-status.json");
const config = { ...parseCaptureConfig({ apiUrl, organizationId, workspaceId, apiToken: "fixture-sensor", sensorId, hookToken: "fixture-hook", operatorToken, port: 8377, bindHost: "127.0.0.1", stateRoot: join(temporary, "capture"), vaultRoot: join(temporary, "vault"), vaultKeyPath: keyFile, processingStatusFile: statusFile, heartbeatWindowMs: 90_000, heartbeatIntervalMs: 30_000, reasoningPolicy: "include", repositoryCapture: { mode: "snapshot", roots: [repository], maxBytes: 1048576, maxFiles: 50, includeUntracked: true, includeBinary: false } }), port: 0 };
const key = await receiptEncryptionKey(config); const spool = new DurableSpool(config.stateRoot);
const engine = new CaptureEngine(config, new StateStore(config.stateRoot), new HookVault(config.vaultRoot, key), spool); await engine.initialize();
const queue = new CaptureReceiptQueue(engine, key);
const common = { session_id: "fixture-attempt", cwd: repository };
async function hook(id, payload) { await queue.accept({ version: 1, id, source: "codex", occurredAt: new Date().toISOString(), endpoint: "/hook", payload: { ...common, ...payload } }); await queue.drain(); }
await hook("fixture-prompt", { hook_event_name: "UserPromptSubmit", task_key: "release-review", prompt: "Review the synthetic release", task_goal: "Ship a reviewed, recoverable release", acceptance_criteria: [{ id: "recoverable", description: "Evidence and repository state remain reconstructible" }] });
await hook("fixture-checkpoint", { hook_event_name: "ReasoningCheckpoint", summary: "Keep immutable evidence when correcting a memory.", hypothesis: "An exact source revision makes later review possible.", model: "fixture-model", provider: "fixture-provider", usage: { input_tokens: 120, output_tokens: 35 } });
await hook("fixture-check", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "synthetic-verification" }, tool_response: { exit_code: 0, output: "fixture check passed" } });
const acceptance = await engine.acceptanceContext("codex", common.session_id);
await queue.accept({ version: 1, id: "fixture-approval", source: "codex", occurredAt: new Date().toISOString(), endpoint: "/decision", payload: { ...common, hook_event_name: "HumanDecision", summary: "Accept this synthetic task revision", acceptance: { version: 1, taskId: acceptance.taskId, attemptId: acceptance.attemptId, revisionId: acceptance.revisionId, verdict: "success" } } }, { kind: "local-operator", principalId: `operator:${sensorId}`, authenticatedAt: new Date().toISOString() }); await queue.drain();
await hook("fixture-stop", { hook_event_name: "Stop" });
const jobs = (await spool.list()).map(({ job }) => job);
for (const job of jobs.filter((job) => job.kind === "event").sort((a, b) => a.event.at.t - b.event.at.t || a.event.id.localeCompare(b.event.id))) await machine.appendEvent(job.event);
const trajectory = jobs.find((job) => job.kind === "trajectory");
if (trajectory === undefined) throw new Error("Fixture capture failed to finalize");
await machine.recordTrajectoryTree(trajectory.treeStamp, trajectory.tree, { captureIdentity: trajectory.captureIdentity });
await machine.recordTrajectory(trajectory.runStamp, trajectory.input, { captureIdentity: trajectory.captureIdentity });
const finalAttempt = trajectory.input.manifest.attempt;
const finalApproval = finalAttempt.acceptance;
await client.recordTaskIntervention(nextEventStamp(), { version: 1, id: "fixture-constraint", taskId: finalAttempt.taskId, attemptId: finalAttempt.attemptId, revisionId: finalAttempt.finalRevision.revisionId, kind: "constraint", observedAt: new Date().toISOString(), sourceEventId: finalApproval.eventId });
await client.recordTaskOutcome(nextEventStamp(), { version: 1, id: "fixture-later-ci", taskId: finalAttempt.taskId, attemptId: finalAttempt.attemptId, revisionId: finalAttempt.finalRevision.revisionId, kind: "ci", result: "success", observedAt: new Date().toISOString(), sourceEventId: finalApproval.eventId });
const references = [];
for (let index = 0; index < 28; index += 1) {
  const stamp = nextEventStamp(Date.now(), "fixture-source");
  const event = makeTerminalObservationEvent({ sensor: sensorId, sessionId: "fixture-sources", heartbeatWindowMs: 90_000, capture: { scope: { workspace: workspaceId }, identity: { principal: "fixture-sensor", workspace: workspaceId, agent: "fixture-agent", task: "fixture-task", branch: "main", repo: "fixture-project", session: "fixture-sources", runtime: "codex", turn: `turn-${index}` } } }, { id: stamp.id, t: stamp.t, observedAt: new Date(stamp.t).toISOString() }, { kind: "reasoning_checkpoint", data: { summary: `Synthetic source ${index + 1}`, artifactId: "reference-only" } });
  await machine.appendEvent(event); references.push({ eventId: event.id, projectId: "fixture-project", turnId: `turn-${index}` });
}
const proposal = (summary, content, evidence) => ({ audience: "workspace", source: "fixture-review", summary, content, projectIds: ["fixture-project"], applicability: { kind: "projects", projectIds: ["fixture-project"] }, evidence, confidence: 0.8, salience: 0.7, extractor: { kind: "rule", id: "fixture", version: "1" } });
const proposed = await machine.proposeMemoryCandidate(proposal("Keep correction history", "A correction must preserve the earlier revision and its evidence.", references.slice(0, 26)));
const accepted = await client.acceptMemoryCandidate(proposed.candidate.id);
await machine.contributeMemoryEvidence(accepted.memory.id, { expectedRevision: 0, evidence: [{ ...references[26], relation: "supports" }, { ...references[27], relation: "opposes" }] });
const source = await client.recordMemory({ audience: "workspace", source: "fixture-owner", summary: "Release checklist", content: "Original checklist", applicability: { kind: "global" } });
await client.recordMemory({ audience: "workspace", source: "fixture-derived", summary: "Checklist guidance needs review", content: "Guidance derived from the earlier checklist.", applicability: { kind: "global" }, sourceMemoryRefs: [{ memoryId: source.memory.id, revision: 0 }] });
await client.reviseMemory(source.memory.id, { content: "Updated checklist: verify restoration before release." }, undefined, { expectedRevision: 0 });
await client.recordMemory({ audience: "workspace", source: "fixture-import", summary: "Choose where this memory applies", content: "This imported note has no confirmed project applicability.", applicability: { kind: "unresolved" } });
await machine.proposeMemoryCandidate(proposal("Review this proposed practice", "Try recording post-deployment outcomes with exact attempt references.", [references[0]]));
await client.recordMemoryFeedback(accepted.memory.id, { version: 2, memoryRevision: 0, recallId: "fixture-usefulness", signal: "judged", judgment: "helpful" });
const capture = new CaptureHttpServer(config, engine, spool, undefined, key); const captureAddress = await capture.start();
const captureUrl = `http://${captureAddress.host}:${captureAddress.port}`;
async function publishStatus() {
  const value = { version: 1, observedAt: new Date().toISOString(), status: "running", subject: { organizationId, workspaceId, principalId: "fixture-sensor" }, coverage: { pending: 2, waiting: 1, retry: 1, completed: 28, excluded: 2, exhausted: 1, oldestPendingAt: Date.now() - 45_000, byKind: { "extract-run": 2, "extract-turn": 1, propose: 1 } }, lagMs: 45_000 };
  await writeFile(`${statusFile}.next`, JSON.stringify(value), { mode: 0o600 }); await rename(`${statusFile}.next`, statusFile);
}
await publishStatus(); const statusTimer = setInterval(() => void publishStatus(), 10_000);
const fixtureEnv = { VITE_CLERK_PUBLISHABLE_KEY: "", VITE_FOLD_API_BASE_URL: "/api", VITE_FOLD_ORGANIZATION: organizationId, VITE_FOLD_WORKSPACE: workspaceId, VITE_FOLD_TOKEN: apiToken, VITE_CAPTURE_BASE_URL: "/capture", VITE_CAPTURE_OPERATOR_TOKEN: operatorToken };
const browser = await createViteServer({ configFile: false, envDir: temporary, root: directory, define: Object.fromEntries(Object.entries(fixtureEnv).map(([name, value]) => [`import.meta.env.${name}`, JSON.stringify(value)])), server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(directory, "../.."), directory] }, proxy: { "/api": { target: apiUrl, rewrite: (path) => path.replace(/^\/api/, "") }, "/capture": { target: captureUrl, rewrite: (path) => path.replace(/^\/capture/, "") } } } });
await browser.listen();
console.log(JSON.stringify({ browserUrl: browser.resolvedUrls.local[0], apiUrl, captureUrl, organizationId, workspaceId, apiToken, operatorToken, readerToken: "fixture-reader", temporary, taskId: trajectory.input.taskId, memoryId: accepted.memory.id, note: "Synthetic fixture only; processing counts are a synthetic publication. Ctrl-C removes all temporary state." }, null, 2));
let closing = false;
async function close() { if (closing) return; closing = true; clearInterval(statusTimer); await browser.close(); await capture.close(); await new Promise((resolve) => api.close(resolve)); await rm(temporary, { recursive: true, force: true }); process.exit(0); }
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
