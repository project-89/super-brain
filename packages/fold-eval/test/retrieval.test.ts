import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRetrievalSuite, retrievalHash, runRetrievalEvaluation, summarizeRetrievalJudgments, validateRetrievalRun, type RetrievalResponse, type RetrievalSuite } from "../src/retrieval.js";
import { collectRetrievalAuthoringSources, createRetrievalApiRecall, retrievalCli, writePrivateReport } from "../src/retrieval-cli.js";

const timestamp = "2026-09-11T12:00:00.000Z";
const suite: RetrievalSuite = {
  schemaVersion: 1,
  id: "fixture-suite",
  organizationId: "organization",
  workspaceId: "workspace",
  projectId: "project",
  topK: 3,
  groundTruth: { status: "reviewed", reviewer: "fixture-human", reviewedAt: timestamp, selectionMethod: "Synthetic fixture; not production validation" },
  questions: [
    { id: "q1", query: "How was fixture failure resolved?", rationale: "Test evidence matching", expectedEvidence: [{ eventId: "source-1", runId: "run-1" }, { eventId: "source-2" }] },
    { id: "q2", query: "What fixture constraint applies?", rationale: "Test a missed source", expectedEvidence: [{ eventId: "source-3" }] },
  ],
};

const response: RetrievalResponse = {
  ranking: { id: "fixture-bm25", kind: "lexical", corpusSize: 10 },
  memories: [
    { score: 1, memory: { id: "m1", workspaceId: "workspace", projectIds: ["project"], summary: "Unrelated first result", revision: 1, evidence: [{ eventId: "different" }] } },
    { score: 0.8, memory: { id: "m2", workspaceId: "workspace", projectIds: ["project"], summary: "Relevant source but usefulness unjudged", revision: 2, evidence: [{ eventId: "source-1", runId: "run-1" }] } },
    { score: 0.5, memory: { id: "m3", workspaceId: "workspace", projectIds: ["project"], summary: "No source", revision: 1 } },
  ],
};

async function fixtureRun() {
  return runRetrievalEvaluation(suite, async (_suite, question) => question.id === "q1" ? response : { ...response, memories: [] }, () => timestamp);
}

describe("project retrieval evaluation", () => {
  it("reports exact evidence and top-k denominators without inventing helpfulness", async () => {
    const run = await fixtureRun();
    expect(run.metrics).toEqual({
      questions: 2, retrieved: 3, requestedSlots: 6,
      evidenceCoverage: { numerator: 1, denominator: 3, value: 1 / 3 },
      questionsWithEvidenceMatch: { numerator: 1, denominator: 2, value: 0.5 },
      retrievedWithEvidence: { numerator: 2, denominator: 3, value: 2 / 3 },
      meanReciprocalEvidenceRank: { numerator: 0.5, denominator: 2, value: 0.25 },
    });
    expect(run.results[0]!.response.ranking.corpusSize).toBe(10);
    expect(run.results[0]!.response.memories[1]!.memory.revision).toBe(2);
    expect(run).not.toHaveProperty("helpful");
    expect(validateRetrievalRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("requires matching qualified run and turn references, not event ID alone", async () => {
    const run = await runRetrievalEvaluation({ ...suite, questions: [{ ...suite.questions[0], expectedEvidence: [{ eventId: "source-1", runId: "other" }, { eventId: "source-1", turnId: "missing" }] }] }, async () => response, () => timestamp);
    expect(run.metrics.evidenceCoverage.numerator).toBe(0);
  });

  it("refuses unreviewed ground truth, empty sources, duplicate IDs and foreign projects", () => {
    expect(() => parseRetrievalSuite({ ...suite, groundTruth: { ...suite.groundTruth, status: "unreviewed" } })).toThrow("unreviewed");
    expect(() => parseRetrievalSuite({ ...suite, questions: [{ ...suite.questions[0], expectedEvidence: [] }] })).toThrow("expectedEvidence");
    expect(() => parseRetrievalSuite({ ...suite, questions: [suite.questions[0], suite.questions[0]] })).toThrow("unique");
    expect(() => parseRetrievalSuite({ ...suite, questions: [{ ...suite.questions[0], expectedEvidence: [{ eventId: "a", projectId: "other" }] }] })).toThrow("suite project");
  });

  it("refuses out-of-scope recall, duplicate memories, and oversized responses", async () => {
    const memory = response.memories[0]!.memory;
    await expect(runRetrievalEvaluation(suite, async () => ({ ...response, memories: [{ memory: { ...memory, workspaceId: "other" } }] }))).rejects.toThrow("out-of-scope");
    await expect(runRetrievalEvaluation(suite, async () => ({ ...response, memories: [{ memory: { ...memory, projectIds: ["other"] } }] }))).rejects.toThrow("out-of-scope");
    await expect(runRetrievalEvaluation(suite, async () => ({ ...response, memories: [response.memories[0], response.memories[0]] }))).rejects.toThrow("unique");
    await expect(runRetrievalEvaluation(suite, async () => ({ ...response, memories: [...response.memories, response.memories[0]] }))).rejects.toThrow("memories");
  });

  it("does not turn network failures into zero-relevance observations", async () => {
    await expect(runRetrievalEvaluation(suite, async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
  });

  it("binds judgments to exact returned questions and immutable result snapshots", async () => {
    const run = await fixtureRun();
    const judgment = { status: "reviewed", questionId: "q1", memoryId: "m2", signal: "helpful", reviewer: "fixture-human", recordedAt: timestamp, reason: "Synthetic reviewer judgment" };
    const input = { schemaVersion: 1, runHash: run.runHash, judgments: [judgment] };
    const summary = summarizeRetrievalJudgments(run, input);
    expect(summary.metrics).toMatchObject({ retrieved: 3, judged: 1, unjudged: 2, helpful: 1, unhelpful: 0, superseded: 0, judgmentCoverage: { numerator: 1, denominator: 3 }, helpfulAmongJudged: { numerator: 1, denominator: 1 } });
    expect(() => summarizeRetrievalJudgments(run, { ...input, runHash: "other" })).toThrow("exact retrieval run");
    expect(() => summarizeRetrievalJudgments(run, { ...input, judgments: [{ ...judgment, questionId: "q2" }] })).toThrow("not returned");
    expect(() => summarizeRetrievalJudgments(run, { ...input, judgments: [judgment, judgment] })).toThrow("unique");
    expect(() => summarizeRetrievalJudgments(run, { ...input, judgments: [{ ...judgment, status: "unreviewed" }] })).toThrow("unreviewed");
    expect(() => summarizeRetrievalJudgments(run, { ...input, judgments: [{ ...judgment, signal: "recalled" }] })).toThrow("explicit");
    expect(() => summarizeRetrievalJudgments({ ...run, finishedAt: "changed" }, input)).toThrow("hash mismatch");
  });

  it("uses null rather than false certainty when nothing is judged or retrieved", async () => {
    const run = await runRetrievalEvaluation(suite, async () => ({ ...response, memories: [] }), () => timestamp);
    const result = summarizeRetrievalJudgments(run, { schemaVersion: 1, runHash: run.runHash, judgments: [] });
    expect(result.metrics.helpfulAmongJudged.value).toBeNull();
    expect(result.metrics.judgmentCoverage.value).toBeNull();
    expect(run.metrics.retrievedWithEvidence.value).toBeNull();
    expect(run.metrics.questionsWithEvidenceMatch.value).toBe(0);
  });

  it("recomputes metrics when reading a report, even if its digest was regenerated", async () => {
    const run = await fixtureRun();
    const { runHash: _, ...body } = run;
    const altered = { ...body, metrics: { ...body.metrics, retrieved: 999 } };
    expect(() => validateRetrievalRun({ ...altered, runHash: retrievalHash(altered) })).toThrow("aggregate metrics");
  });
});

describe("retrieval CLI", () => {
  const directories: string[] = [];
  afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

  it("uses only scoped read endpoints and refuses credential-bearing redirects or remote HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    await createRetrievalApiRecall("http://127.0.0.1:3003/api", "fixture-token", fetcher)(suite, suite.questions[0]!);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:3003/api/organizations/organization/workspaces/workspace/memories/search");
    expect(options!.redirect).toBe("error");
    expect(JSON.parse(options!.body as string)).toEqual({ scope: { kind: "all" }, projectIds: ["project"], query: suite.questions[0]!.query, limit: 3 });
    expect(() => createRetrievalApiRecall("http://remote.test/api", "token")).toThrow("HTTPS");
    expect(() => createRetrievalApiRecall("https://user:password@example.com/api", "token")).toThrow("credentials");
    expect(() => createRetrievalApiRecall("http://localhost/api", "")).toThrow("FOLD_EVAL_TOKEN");
  });

  it("paginates every authoring source and preserves full contents without claiming review", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ memories: response.memories.slice(0, 1), total: 2, nextCursor: "page-two" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ memories: response.memories.slice(1, 2), total: 2 })));
    const catalog = await collectRetrievalAuthoringSources(suite, "http://localhost/api", "fixture-token", fetcher);
    expect(catalog).toMatchObject({ status: "unreviewed", records: 2, completePagination: true, reportedTotals: [2, 2] });
    expect(catalog.memories[1]).toEqual(response.memories[1]!.memory);
    expect(String(fetcher.mock.calls[1]![0])).toContain("pageCursor=page-two");
    expect(fetcher.mock.calls.every((call) => call[1]!.method === "GET")).toBe(true);
  });

  it("rejects foreign authoring sources and repeated pagination", async () => {
    const foreign = { ...response.memories[0], memory: { ...response.memories[0]!.memory, projectIds: ["foreign"] } };
    await expect(collectRetrievalAuthoringSources(suite, "http://localhost/api", "fixture-token", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ memories: [foreign], total: 1 }))))).rejects.toThrow("out-of-scope");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ memories: response.memories.slice(0, 1), total: 2, nextCursor: "again" })));
    await expect(collectRetrievalAuthoringSources(suite, "http://localhost/api", "fixture-token", fetcher)).rejects.toThrow("changed during pagination");
  });

  it("writes private, non-overwriting drafts and explicitly unreviewed judgment sheets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-eval-test-"));
    directories.push(directory);
    const template = join(directory, "suite.json");
    await retrievalCli(["template", "--organization", "org", "--workspace", "ws", "--project", "project", "--out", template]);
    expect((await stat(template)).mode & 0o777).toBe(0o600);
    const draft = JSON.parse(await readFile(template, "utf8"));
    expect(draft.groundTruth.status).toBe("unreviewed");
    expect(() => parseRetrievalSuite(draft)).toThrow("unreviewed");
    await expect(writePrivateReport(template, {})).rejects.toThrow();
    const run = await fixtureRun();
    const runPath = join(directory, "run.json");
    const judgmentsPath = join(directory, "judgments.json");
    await writePrivateReport(runPath, run);
    await retrievalCli(["review-template", "--report", runPath, "--out", judgmentsPath]);
    const draftJudgments = JSON.parse(await readFile(judgmentsPath, "utf8"));
    expect(draftJudgments.judgments).toHaveLength(3);
    expect(draftJudgments.judgments[0]).toMatchObject({ status: "unreviewed", signal: null });
    expect(() => summarizeRetrievalJudgments(run, draftJudgments)).toThrow("unreviewed");
    draftJudgments.judgments = [];
    const emptyPath = join(directory, "unjudged.json");
    const summaryPath = join(directory, "summary.json");
    await writePrivateReport(emptyPath, draftJudgments);
    await retrievalCli(["summarize", "--report", runPath, "--judgments", emptyPath, "--out", summaryPath]);
    expect(JSON.parse(await readFile(summaryPath, "utf8")).metrics.unjudged).toBe(3);
  });
});
