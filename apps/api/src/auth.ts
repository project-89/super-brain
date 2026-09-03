import { createHash } from "node:crypto";

import { authorSchema } from "@_89/fold";
import { validateAccessContext } from "@_89/fold-epistemic";
import { z } from "zod";

import type {
  AuthenticatedSubject,
  ApiCapability,
  Authenticator,
  MembershipResolver,
} from "./types.js";

const staticWorkspaceMembershipSchema = z
  .object({
    role: z.enum(["owner", "admin", "member"]),
    spaces: z.record(z.enum(["admin", "writer", "reader"])).optional(),
  })
  .strict();

const staticCredentialMapSchema = z.record(
  z
    .object({
      principalId: z.string().min(1),
      author: authorSchema.optional(),
      capabilities: z.array(z.enum([
        "events:read",
        "events:write",
        "memories:read",
        "memories:write",
        "trajectories:read",
        "trajectories:write",
        "transcripts:read",
        "transcripts:write",
        "fleet:read",
        "steering:read",
        "steering:write",
        "reasoning:read",
        "consumers:read",
        "consumers:write",
      ])).max(14).optional(),
      workspaces: z.record(staticWorkspaceMembershipSchema),
    })
    .strict(),
);

type ParsedCredentialMap = z.infer<typeof staticCredentialMapSchema>;
type ParsedWorkspaceMembership = z.infer<typeof staticWorkspaceMembershipSchema>;

interface StoredCredential {
  readonly subject: AuthenticatedSubject;
  readonly workspaces: ParsedCredentialMap[string]["workspaces"];
}

export class StaticCredentialConfigurationError extends Error {
  override readonly name = "StaticCredentialConfigurationError";
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new StaticCredentialConfigurationError(`${label} must not be empty`);
  }
}

function credentialId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateMembership(
  principalId: string,
  workspaceId: string,
  membership: ParsedWorkspaceMembership,
): void {
  nonEmpty(workspaceId, "workspace id");
  validateAccessContext({
    principalId,
    workspaceId,
    workspaceRole: membership.role,
    spaceRoles: membership.spaces ?? {},
  });
}

function parseConfiguration(input: unknown): ParsedCredentialMap {
  const parsed = staticCredentialMapSchema.safeParse(input);
  if (!parsed.success) {
    throw new StaticCredentialConfigurationError(
      `credential configuration is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

export class StaticIdentityDirectory implements Authenticator, MembershipResolver {
  private readonly credentials = new Map<string, StoredCredential>();

  constructor(configuration: unknown) {
    const parsedConfiguration = parseConfiguration(configuration);
    for (const [token, configured] of Object.entries(parsedConfiguration)) {
      nonEmpty(token, "credential token");
      nonEmpty(configured.principalId, "credential principalId");
      const author = authorSchema.parse(
        configured.author ?? { kind: "human", id: configured.principalId },
      );
      for (const [workspaceId, membership] of Object.entries(configured.workspaces)) {
        validateMembership(configured.principalId, workspaceId, membership);
      }
      const id = credentialId(token);
      this.credentials.set(id, {
        subject: {
          credentialId: id,
          principalId: configured.principalId,
          author,
          ...(configured.capabilities === undefined
            ? {}
            : { capabilities: [...new Set(configured.capabilities)] as ApiCapability[] }),
        },
        workspaces: configured.workspaces,
      });
    }
    if (this.credentials.size === 0) {
      throw new StaticCredentialConfigurationError("at least one credential is required");
    }
  }

  static fromJson(json: string): StaticIdentityDirectory {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new StaticCredentialConfigurationError("credential configuration is not valid JSON");
    }
    return new StaticIdentityDirectory(parseConfiguration(parsed));
  }

  async authenticate(bearerToken: string): Promise<AuthenticatedSubject | undefined> {
    if (bearerToken.length === 0) return undefined;
    const subject = this.credentials.get(credentialId(bearerToken))?.subject;
    return subject === undefined
      ? undefined
      : {
          ...subject,
          author: { ...subject.author },
          ...(subject.capabilities === undefined ? {} : { capabilities: [...subject.capabilities] }),
        };
  }

  async resolveAccess(
    subject: AuthenticatedSubject,
    workspaceId: string,
  ) {
    const stored = this.credentials.get(subject.credentialId);
    if (
      stored === undefined ||
      stored.subject.principalId !== subject.principalId ||
      stored.subject.author.kind !== subject.author.kind ||
      stored.subject.author.id !== subject.author.id ||
      stored.subject.author.productionId !== subject.author.productionId ||
      JSON.stringify(stored.subject.capabilities) !== JSON.stringify(subject.capabilities)
    ) {
      return undefined;
    }
    const membership = stored.workspaces[workspaceId];
    if (membership === undefined) return undefined;
    return {
      principalId: subject.principalId,
      workspaceId,
      workspaceRole: membership.role,
      spaceRoles: { ...(membership.spaces ?? {}) },
    };
  }
}
