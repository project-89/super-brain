import { describe, expect, it } from "vitest";
import { MEMORY_A, apiRequest, memoryRecordBody, startApi } from "./helpers.js";
import { StaticIdentityDirectory } from "../src/index.js";
import { FoldSdk } from "@_89/fold-sdk";
import type { FoldLogEntry } from "@_89/fold";

describe("evaluation selection HTTP boundary", () => {
  it.each(["workspace", "space"] as const)("rejects %s revocation while an authorized selection is waiting on storage", async (scope) => {
    const directory = new StaticIdentityDirectory({ writer:{principalId:"writer",workspaces:{"workspace-1":{role:"owner",spaces:{private:"writer"}}}},reader:{principalId:"reader",capabilities:["memories:read"],workspaces:{"workspace-1":{role:"member",spaces:{private:"reader"}}}} });
    let revoked = false, delay = false, entered!:()=>void, release!:()=>void;
    const started = new Promise<void>((resolve)=>{entered=resolve;}); const waiting = new Promise<void>((resolve)=>{release=resolve;});
    const entries: FoldLogEntry[] = [];
    const sdk = new FoldSdk({read:async()=>{const snapshot=[...entries];if(delay){entered();await waiting;}return{entries:snapshot};},append:async(entry)=>{entries.push(entry);},appendMany:async(additions)=>{entries.push(...additions);}});
    const memberships = {
      resolveAccess: async (...args:Parameters<typeof directory.resolveAccess>)=>{const access=await directory.resolveAccess(...args);return revoked&&args[0].principalId==="reader"?(scope==="workspace"?undefined:access===undefined?undefined:{...access,spaceRoles:{}}):access;},
      resolveLegacyAccess: async (...args:Parameters<typeof directory.resolveLegacyAccess>)=>{const access=await directory.resolveLegacyAccess(...args);return revoked&&args[0].principalId==="reader"?(scope==="workspace"?undefined:access===undefined?undefined:{...access,spaceRoles:{}}):access;},
    };
    const api = await startApi({authenticator:directory,memberships,sdks:{sdkFor:async()=>sdk}});
    const path="/v1/workspaces/workspace-1";
    try {
      const record=memoryRecordBody();expect((await apiRequest(api.baseUrl,`${path}/memories`,{token:"writer",method:"POST",body:{...record,input:{...record.input,audience:"workspace",spaceId:"private",applicability:{kind:"global"}}}})).status).toBe(201);
      const reference={kind:"memory",memoryId:MEMORY_A,revision:0};delay=true;
      const response=apiRequest(api.baseUrl,`${path}/evaluation-sources/selection`,{token:"reader",method:"POST",body:{selectionId:"selection",audience:"local-reviewed",redactionVersion:"v1",expectedSubject:{organizationId:"local",workspaceId:"workspace-1",principalId:"reader"},references:[reference],reviewedReferences:[reference]}});
      await started;revoked=true;release();
      expect(await response).toMatchObject({status:403,body:{error:{code:scope==="workspace"?"workspace_access_denied":"evaluation_access_changed"}}});
    } finally {release();await api.close();}
  });

  it("binds selected revisions to a fresh authorized account and explicit local review", async () => {
    const directory = new StaticIdentityDirectory({ writer: { principalId: "writer", workspaces: { "workspace-1": { role: "owner" } } }, reader: { principalId: "reader", capabilities: ["memories:read"], workspaces: { "workspace-1": { role: "member" } } } });
    const api = await startApi({ authenticator: directory, memberships: directory });
    const path = "/v1/workspaces/workspace-1";
    try {
      const record = memoryRecordBody();
      expect((await apiRequest(api.baseUrl, `${path}/memories`, { token: "writer", method: "POST", body: { ...record, input: { ...record.input, audience: "workspace", applicability: { kind: "global" } } } })).status).toBe(201);
      const reference = { kind: "memory", memoryId: MEMORY_A, revision: 0 };
      const body = { selectionId: "synthetic-selection", audience: "local-reviewed", redactionVersion: "v1", expectedSubject: { organizationId: "local", workspaceId: "workspace-1", principalId: "reader" }, references: [reference], reviewedReferences: [reference] };
      const select = (value: unknown, token = "reader") => apiRequest(api.baseUrl, `${path}/evaluation-sources/selection`, { token, method: "POST", body: value });
      expect(await select(body)).toMatchObject({ status: 200, body: { eligible: [{ reference, eligibility: "current-authorized" }], excluded: [] } });
      expect(await select({ ...body, reviewedReferences: [] })).toMatchObject({ status: 200, body: { eligible: [], excluded: [{ reason: "unreviewed" }] } });
      expect(await select(body, "writer")).toMatchObject({ status: 409, body: { error: { code: "evaluation_subject_changed" } } });
      expect((await select({ ...body, audience: "public" })).status).toBe(400);
      expect((await select({ ...body, references: [{ kind: "event", eventId: "arbitrary" }], reviewedReferences: [] })).status).toBe(403);
      expect((await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}`, { token: "writer", method: "DELETE", body: { stamp: { id: "forget", t: 200, worldDate: "2026-09-04" }, reason: "removed" } })).status).toBe(200);
      expect(await select(body)).toMatchObject({ status: 200, body: { eligible: [], excluded: [{ reason: "unavailable-or-denied" }] } });
    } finally { await api.close(); }
  });
});
