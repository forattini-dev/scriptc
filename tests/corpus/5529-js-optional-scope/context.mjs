import { getActiveRuntimeScope } from './scope.mjs';
export function getAppContext(scope) { return scope ? scope.id : -1; }
export function useActiveContext() {
  const activeScope = getActiveRuntimeScope();
  return activeScope ? getAppContext(activeScope) : getAppContext();
}
export function hasActiveContext() {
  const activeScope = getActiveRuntimeScope();
  if (activeScope && getAppContext(activeScope)) return true;
  return false;
}
