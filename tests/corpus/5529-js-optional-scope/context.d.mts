import type { RuntimeScope } from './scope.mjs';
export function getAppContext(scope?: RuntimeScope): number;
export function useActiveContext(): number;
export function hasActiveContext(): boolean;
