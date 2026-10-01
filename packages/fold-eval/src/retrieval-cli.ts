import { readFile, open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { runRetrievalEvaluation, summarizeRetrievalJudgments, validateRetrievalRun, type RetrievalQuestion, type RetrievalSuite } from "./retrieval.js";

export async function writePrivateReport(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

function apiRequest(base: string, token: string, fetcher: typeof fetch) {
  const baseUrl = new URL(base);
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("API URL must not include credentials, query, or fragment");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback)) throw new Error("API requires HTTPS except on loopback");
  if (!token.trim()) throw new Error("FOLD_EVAL_TOKEN must contain a workspace read credential");
  return async (scope: { organizationId: string; workspaceId: string }, resource: string, body?: unknown): Promise<unknown> => {
    const url = new URL(baseUrl.toString().replace(/\/$/, "") + "/organizations/" + encodeURIComponent(scope.organizationId) + "/workspaces/" + encodeURIComponent(scope.workspaceId) + "/" + resource);
    const response = await fetcher(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Read request failed: HTTP ${response.status}. No evaluation report was produced.`);
    return response.json();
  };
}

export function createRetrievalApiRecall(base: string, token: string, fetcher: typeof fetch = fetch) {
  const request = apiRequest(base, token, fetcher);
  return (suite: RetrievalSuite, question: RetrievalQuestion) => request(suite, "memories/search", { scope: { kind: "all" }, projectIds: [suite.projectId], query: question.query, limit: suite.topK });
}

export async function collectRetrievalAuthoringSources(
  scope: { organizationId: string; workspaceId: string; projectId: string },
  base: string,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const request = apiRequest(base, token, fetcher);
  const startedAt = new Date().toISOString();
  const memories: unknown[] = [];
  const cursors = new Set<string>();
  const memoryIds = new Set<string>();
  let cursor: string | undefined;
  const reportedTotals: number[] = [];
  do {
    const query = new URLSearchParams({ projectId: scope.projectId, scope: "all", limit: "100" });
    if (cursor !== undefined) query.set("pageCursor", cursor);
    const page = await request(scope, "memories?" + query) as { memories?: { memory?: { id?: string; workspaceId?: string; projectIds?: string[] } }[]; nextCursor?: string; total?: number };
    if (!page || !Array.isArray(page.memories) || !Number.isSafeInteger(page.total) || page.total! < 0) throw new Error("Invalid source catalog page");
    reportedTotals.push(page.total!);
    for (const entry of page.memories) {
      const memory = entry.memory;
      if (!memory || typeof memory.id !== "string" || memory.workspaceId !== scope.workspaceId || !Array.isArray(memory.projectIds) || !memory.projectIds.includes(scope.projectId)) throw new Error("Source catalog contains an out-of-scope or malformed memory");
      if (memoryIds.has(memory.id)) throw new Error("Source catalog changed during pagination; retry to avoid duplicate authoring sources");
      memoryIds.add(memory.id);
      memories.push(memory);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || cursor.length === 0 || page.memories.length === 0 || cursors.has(cursor)) throw new Error("Invalid or repeated source catalog cursor");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return {
    status: "unreviewed",
    startedAt,
    finishedAt: new Date().toISOString(),
    scope,
    records: memories.length,
    reportedTotals,
    completePagination: true,
    warning: "Authoring aid only: accepted memories and their evidence have not been verified here. Inspect original sources; do not choose expected sources from ranked results. The live corpus may change between pages.",
    memories,
  };
}

async function readJson(path: string | undefined, option: string): Promise<unknown> {
  if (path === undefined) throw new Error(`${option} is required`);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function retrievalCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: {
    suite: { type: "string" }, report: { type: "string" }, judgments: { type: "string" }, out: { type: "string" },
    api: { type: "string" }, organization: { type: "string" }, workspace: { type: "string" }, project: { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  const [command] = positionals;
  if (values.help || command === undefined) return [
    "Retrieval evaluation (read-only; no memory writes or promotions)",
    "  template --organization ID --workspace ID --project ID --out suite.json",
    "  prepare --organization ID --workspace ID --project ID --out suite.json (includes a paginated authoring source catalog)",
    "  run --suite suite.json --api http://127.0.0.1:3003/v1 --out run.json",
    "  review-template --report run.json --out judgments.json",
    "  summarize --report run.json --judgments judgments.json --out evaluation.json",
    "Set FOLD_EVAL_TOKEN for run. Reports are private and cannot overwrite existing files.",
  ].join("\n");
  if (positionals.length !== 1) throw new Error("Exactly one command is required");
  if (values.out === undefined) throw new Error("--out is required");
  let output: unknown;
  if (command === "template" || command === "prepare") {
    if (!values.organization || !values.workspace || !values.project) throw new Error("--organization, --workspace, and --project are required");
    output = {
      schemaVersion: 1,
      id: `${values.project}-retrieval-v1`,
      organizationId: values.organization,
      workspaceId: values.workspace,
      projectId: values.project,
      topK: 5,
      groundTruth: { status: "unreviewed", reviewer: "", reviewedAt: "", selectionMethod: "Choose real project questions and inspect their source evidence before running retrieval, not from the returned results." },
      questions: [
        { id: "decision", query: "", expectedEvidence: [], rationale: "What project decision should be recalled, and which inspected source records establish it?" },
        { id: "failure", query: "", expectedEvidence: [], rationale: "Which prior failure and verified fix should help this project?" },
        { id: "constraint", query: "", expectedEvidence: [], rationale: "Which project-specific constraint should be remembered during future work?" },
      ],
      ...(command === "prepare" ? { sourceCatalog: await collectRetrievalAuthoringSources(
        { organizationId: values.organization, workspaceId: values.workspace, projectId: values.project },
        values.api ?? env.FOLD_EVAL_API ?? "http://127.0.0.1:3003/v1", env.FOLD_EVAL_TOKEN ?? "",
      ) } : {}),
    };
  } else if (command === "run") {
    output = await runRetrievalEvaluation(await readJson(values.suite, "--suite"), createRetrievalApiRecall(values.api ?? env.FOLD_EVAL_API ?? "http://127.0.0.1:3003/v1", env.FOLD_EVAL_TOKEN ?? ""));
  } else if (command === "review-template") {
    const run = validateRetrievalRun(await readJson(values.report, "--report"));
    output = {
      schemaVersion: 1,
      runHash: run.runHash,
      judgments: run.results.flatMap((result) => result.response.memories.map(({ memory }) => ({
        status: "unreviewed",
        questionId: result.questionId,
        memoryId: memory.id,
        signal: null,
        reviewer: "",
        recordedAt: "",
        reason: "",
      }))),
    };
  } else if (command === "summarize") {
    output = summarizeRetrievalJudgments(await readJson(values.report, "--report"), await readJson(values.judgments, "--judgments"));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  await writePrivateReport(values.out, output);
  return `${command}: wrote ${values.out}. No canonical data was modified.`;
}
