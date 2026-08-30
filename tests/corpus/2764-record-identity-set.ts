interface RuntimeScope {
  readonly id: number;
  readonly name: string;
}

const scopes = new Set<RuntimeScope>();
const primary: RuntimeScope = { id: 1, name: "main" };
const alias = primary;
const structuralTwin: RuntimeScope = { id: 1, name: "main" };

scopes.add(primary);
scopes.add(alias);
scopes.add(structuralTwin);

console.log(
  scopes.size,
  scopes.has(primary),
  scopes.has(alias),
  scopes.has(structuralTwin),
  scopes.has({ id: 1, name: "main" }),
);
console.log(scopes.delete(alias), scopes.has(primary), scopes.size);
console.log(scopes.delete(alias), scopes.delete(structuralTwin), scopes.size);
