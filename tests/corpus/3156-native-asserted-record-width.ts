// @rust-only
// @no-engine
const source = { id: 9, extra: true };
const narrowed = source as { id: number };
console.log(JSON.stringify(narrowed));
source.id = 10;
console.log(narrowed.id);
const sourceIdentity: unknown = source;
const narrowedIdentity: unknown = narrowed;
console.log(sourceIdentity === narrowedIdentity);
narrowed.id = 11;
console.log(source.id);
