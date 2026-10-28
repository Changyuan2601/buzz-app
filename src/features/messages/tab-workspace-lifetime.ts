/** Shared partition owner for window-session tab storage and leave cleanup. */
export const tabWorkspaceStorageKey = (scope: string) =>
  `buzz-tab-workspaces.v1:${scope}`;
const purges = new Map<string, () => void>();

/** The tab owner supplies only invalidation, never a runtime workspace to features. */
export function retainTabWorkspace(scope: string, forget: () => void) {
  purges.set(scope, forget);
}

/** Revoke the live writer even when removing browser storage fails. */
export function forgetTabWorkspaces(scope: string) {
  const forget = purges.get(scope);
  purges.delete(scope);
  forget?.();
  sessionStorage.removeItem(tabWorkspaceStorageKey(scope));
}
