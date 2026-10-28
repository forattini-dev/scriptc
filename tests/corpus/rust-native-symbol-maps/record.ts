export {};
interface Scope { resources: Map<symbol, unknown> }
const scope: Scope = { resources: new Map<symbol, unknown>() };
const sameScope = scope;
const first = Symbol('resource');
const other = Symbol('resource');
let creations = 0;
function make(): unknown { creations += 1; return { id: creations }; }
function getResource(target: Scope, key: symbol, create: () => unknown): unknown {
  if (!target.resources.has(key)) target.resources.set(key, create());
  return target.resources.get(key);
}
const value = getResource(scope, first, make);
console.log('cached', value === getResource(sameScope, first, make), creations);
console.log('distinct', value === getResource(scope, other, make), creations);
console.log('size', scope.resources.size, sameScope.resources.has(first));
