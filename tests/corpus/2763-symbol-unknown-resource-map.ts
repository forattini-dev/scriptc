interface RuntimeScope {
  readonly id: number;
  readonly resources: Map<symbol, unknown>;
}

const labelResource = Symbol("label");
const countResource = Symbol("count");
const missingResource = Symbol("missing");

const scope: RuntimeScope = {
  id: 7,
  resources: new Map(),
};

scope.resources.set(labelResource, "active");
scope.resources.set(countResource, 3);

const label = scope.resources.get(labelResource);
const count = scope.resources.get(countResource);
const missing = scope.resources.get(missingResource);

console.log(scope.id, scope.resources.size);
console.log(typeof label === "string" ? label.toUpperCase() : "missing");
console.log(typeof count === "number" ? count + 4 : -1);
console.log(missing === undefined, scope.resources.has(labelResource));
console.log(scope.resources.delete(labelResource), scope.resources.has(labelResource));
