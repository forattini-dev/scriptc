export interface RuntimeScope { id: number; resources: Map<string, string> }
export function createRuntimeScope(id: number): RuntimeScope;
export function setActiveRuntimeScope(scope: RuntimeScope | null): void;
export function getActiveRuntimeScope(): RuntimeScope | null;
