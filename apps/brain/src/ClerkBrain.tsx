import {
  OrganizationList,
  OrganizationSwitcher,
  SignIn,
  UserButton,
  useAuth,
} from "@clerk/react";
import { BrainCircuit } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import App from "./App";
import type { ConnectionSettings } from "./types";

interface SessionMembership {
  readonly organizationId: string;
  readonly organizationRole: "owner" | "admin" | "member";
  readonly workspaceId: string;
  readonly workspaceRole: "owner" | "member" | "reader";
}

interface AuthenticatedSession {
  readonly principalId: string;
  readonly identityProvider: string;
  readonly organizationId: string;
  readonly memberships: readonly SessionMembership[];
}

function baseUrl(): string {
  const value = (import.meta.env.VITE_FOLD_API_BASE_URL ?? "/api").trim();
  return value === "/" ? "" : value.replace(/\/$/, "");
}

function AuthSurface({ children }: { readonly children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <header className="auth-brand"><BrainCircuit aria-hidden="true" /><strong>Super Brain</strong></header>
      {children}
    </main>
  );
}

export default function ClerkBrain() {
  const { getToken, isLoaded, isSignedIn, orgId } = useAuth();
  const [session, setSession] = useState<AuthenticatedSession>();
  const [token, setToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSession(undefined);
    setWorkspaceId("");
    setError(undefined);
    if (!isLoaded || !isSignedIn || orgId === undefined) return;

    const controller = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const nextToken = await getToken();
        if (nextToken === null) throw new Error("Clerk did not issue an API token");
        const response = await fetch(`${baseUrl()}/v1/session`, {
          headers: { authorization: `Bearer ${nextToken}` },
          signal: controller.signal,
        });
        const body = await response.json() as AuthenticatedSession | { readonly error?: { readonly message?: string } };
        if (!response.ok) {
          throw new Error("error" in body ? body.error?.message ?? `Session discovery failed (${response.status})` : `Session discovery failed (${response.status})`);
        }
        const discovered = body as AuthenticatedSession;
        setToken(nextToken);
        setSession(discovered);
        setWorkspaceId((current) => discovered.memberships.some((membership) => membership.workspaceId === current)
          ? current
          : discovered.memberships[0]?.workspaceId ?? "");
        setError(undefined);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Session discovery failed");
      }
    };
    void refresh();
    timer = window.setInterval(() => void refresh(), 45_000);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [getToken, isLoaded, isSignedIn, orgId]);

  const connection = useMemo<ConnectionSettings | undefined>(() => {
    if (session === undefined || token.length === 0 || workspaceId.length === 0) return undefined;
    return {
      baseUrl: baseUrl(),
      organizationId: session.organizationId,
      workspaceId,
      token,
      captureBaseUrl: "",
      captureOperatorToken: "",
    };
  }, [session, token, workspaceId]);

  if (!isLoaded) return <AuthSurface><div className="auth-status">Loading identity</div></AuthSurface>;
  if (!isSignedIn) return <AuthSurface><SignIn /></AuthSurface>;
  if (orgId === undefined) {
    return <AuthSurface><OrganizationList hidePersonal /></AuthSurface>;
  }
  if (error !== undefined) {
    return (
      <AuthSurface>
        <section className="auth-status auth-status--error"><strong>Workspace access unavailable</strong><span>{error}</span><OrganizationSwitcher hidePersonal /></section>
      </AuthSurface>
    );
  }
  if (session === undefined) return <AuthSurface><div className="auth-status">Loading workspaces</div></AuthSurface>;
  if (connection === undefined) {
    return (
      <AuthSurface>
        <section className="auth-status auth-status--error"><strong>No workspace access</strong><span>Ask an organization administrator to provision a workspace membership.</span><OrganizationSwitcher hidePersonal /></section>
      </AuthSurface>
    );
  }

  return (
    <App
      connectionOverride={connection}
      accountControls={(
        <div className="account-controls">
          {session.memberships.length > 1 && (
            <select aria-label="Workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              {session.memberships.map((membership) => <option key={membership.workspaceId} value={membership.workspaceId}>{membership.workspaceId}</option>)}
            </select>
          )}
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </div>
      )}
    />
  );
}
