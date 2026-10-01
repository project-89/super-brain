import { z } from "zod";

export const projectScopeIdsSchema = z.array(z.string().trim().min(1).max(300)).min(1).max(20);

export function configuredProjectIds(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TypeError("SUPER_BRAIN_PROJECT_IDS must be a JSON array of 1 to 20 project IDs"); }
  const result = projectScopeIdsSchema.safeParse(parsed);
  if (!result.success) throw new TypeError("SUPER_BRAIN_PROJECT_IDS must be a JSON array of 1 to 20 nonempty project IDs (at most 300 characters each)");
  return [...new Set(result.data)];
}

export type RetrievalScope = { readonly kind: "project"; readonly source: "explicit" | "configured"; readonly projectIds: readonly string[] }
  | { readonly kind: "broader-discovery"; readonly source: "explicit" };

interface ProjectPage {
  readonly items: readonly { readonly id: string }[];
  readonly nextCursor?: string;
  readonly scope: { readonly workspaceId: string };
}

export async function resolveRetrievalScope(input: {
  readonly projectIds?: readonly string[];
  readonly broaderDiscovery?: boolean;
}, options: {
  readonly defaultProjectIds?: readonly string[];
  readonly workspaceId: string;
  readonly loadProjectPage: (cursor?: string) => Promise<ProjectPage>;
}): Promise<RetrievalScope> {
  if (input.broaderDiscovery === true) {
    if (input.projectIds !== undefined) throw new TypeError("Choose projectIds or broaderDiscovery, not both");
    return { kind: "broader-discovery", source: "explicit" };
  }
  const requested = input.projectIds ?? options.defaultProjectIds;
  if (requested === undefined) {
    throw new TypeError("Project context is required: supply nonempty projectIds, configure SUPER_BRAIN_PROJECT_IDS, or explicitly set broaderDiscovery:true");
  }
  const projectIds = [...new Set(projectScopeIdsSchema.parse(requested))];
  const remaining = new Set(projectIds);
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > 1000) throw new RangeError("Project catalog verification exceeds 1000 pages; use a narrower authorized workspace");
    const page = await options.loadProjectPage(cursor);
    if (page.scope.workspaceId !== options.workspaceId || !Array.isArray(page.items)) throw new TypeError("Project catalog returned an invalid workspace scope");
    for (const item of page.items) {
      if (typeof item.id !== "string" || !item.id) throw new TypeError("Project catalog returned an invalid project ID");
      remaining.delete(item.id);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || cursor.length === 0 || seenCursors.has(cursor)) throw new TypeError("Project catalog returned an invalid cursor");
      seenCursors.add(cursor);
    }
  } while (remaining.size > 0 && cursor !== undefined);
  if (remaining.size > 0) throw new TypeError("Requested project IDs are unavailable in this authorized workspace; select accessible IDs or explicitly request broader discovery");
  return { kind: "project", source: input.projectIds === undefined ? "configured" : "explicit", projectIds };
}
