import {
  OrganizationList,
  OrganizationSwitcher,
  SignIn,
  UserButton,
  useAuth,
} from "@clerk/react";
import { SuperBrainClient, type AuthenticatedSession, type TokenSupplier } from "@_89/super-brain-client";
import { BrainCircuit } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import App from "./App";
import type { ConnectionSettings } from "./types";

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
  const { getToken, isLoaded, isSignedIn, orgId, userId, sessionId } = useAuth();
  const sessionKey = JSON.stringify([orgId, userId, sessionId]);
  const [discoveredKey, setDiscoveredKey] = useState<string>();
  const [session, setSession] = useState<AuthenticatedSession>();
  const tokenSupplier = useMemo<TokenSupplier>(() => async (signal) => {
    if (signal?.aborted || !isLoaded || !isSignedIn || orgId == null) return undefined;
    return (await getToken()) ?? undefined;
  }, [getToken, isLoaded, isSignedIn, orgId, userId, sessionId]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSession(undefined); setDiscoveredKey(undefined);
    setWorkspaceId("");
    setError(undefined);
    if (!isLoaded || !isSignedIn || orgId == null) return;

    const controller = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const client = new SuperBrainClient({ baseUrl: baseUrl(), organizationId: orgId ?? undefined, workspaceId: "", token: tokenSupplier, signal: controller.signal });
        const discovered = await client.session();
        if (controller.signal.aborted) return;
        setSession(discovered); setDiscoveredKey(sessionKey);
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
  }, [tokenSupplier, isLoaded, isSignedIn, orgId, sessionKey]);

  const connection = useMemo<ConnectionSettings | undefined>(() => {
    if (session === undefined || discoveredKey !== sessionKey || workspaceId.length === 0) return undefined;
    return {
      baseUrl: baseUrl(),
      organizationId: session.organizationId,
      workspaceId,
      token: "",
      tokenSupplier,
      captureBaseUrl: "",
      captureOperatorToken: "",
    };
  }, [session, tokenSupplier, workspaceId, discoveredKey, sessionKey]);

  if (!isLoaded) return <AuthSurface><div className="auth-status">Loading identity</div></AuthSurface>;
  if (!isSignedIn) return <AuthSurface><SignIn /></AuthSurface>;
  if (orgId == null) {
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
    <App key={sessionKey}
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
