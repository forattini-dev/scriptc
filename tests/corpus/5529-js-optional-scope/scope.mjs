let active = null;
export function createRuntimeScope(id) { return { id, resources: new Map() }; }
export function setActiveRuntimeScope(scope) { active = scope; }
export function getActiveRuntimeScope() { return active; }
