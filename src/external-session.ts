import { AuthError } from "./types.js";
import type { AuthStore, ExternalSessionSource, SessionContinuity } from "./types.js";

interface ExternalSessionBinding {
  source: ExternalSessionSource;
  getRevision(): number | null;
  endSession<T>(operation: () => Promise<T>): Promise<T>;
}

// Internal only: consumers keep the existing AuthStore interface.
const bindings = new WeakMap<AuthStore, ExternalSessionBinding>();

export function bindExternalSession(store: AuthStore, binding: ExternalSessionBinding): void {
  bindings.set(store, binding);
}

export function externalSessionFor(store: AuthStore): ExternalSessionBinding | undefined {
  return bindings.get(store);
}

export function unsupportedExternalOperation(operation: string): AuthError {
  return new AuthError(
    400,
    "EXTERNAL_SESSION_UNSUPPORTED",
    `${operation} is unavailable for an external session. Use the configured session provider's sign-in or session management flow.`,
  );
}

const continuityRevisions = new WeakMap<SessionContinuity, {
  binding: ExternalSessionBinding;
  revision: number;
}>();

export function rememberExternalContinuity(store: AuthStore, continuity: SessionContinuity): boolean {
  const binding = bindings.get(store);
  if (!binding) return true;
  const revision = binding.getRevision();
  if (revision === null || store.getSessionState?.().status !== "ready") return false;
  continuityRevisions.set(continuity, { binding, revision });
  return true;
}

export function matchesExternalContinuity(store: AuthStore, continuity: SessionContinuity): boolean {
  const binding = bindings.get(store);
  const captured = continuityRevisions.get(continuity);
  if (!binding) return captured === undefined;
  return captured?.binding === binding && captured.revision === binding.getRevision();
}

/** Successful external responses belong to the captured provider epoch and local tenant. */
export function acceptsExternalResponse(store: AuthStore, before: SessionContinuity | null): boolean {
  if (!bindings.has(store)) return true;
  if (!before || !matchesExternalContinuity(store, before)) return false;
  const state = store.getSessionState?.();
  return (state?.status === "ready" || state?.status === "revalidating") &&
    state.user.id === before.userId && state.user.orgId === before.orgId;
}
