// @rust-only
// @no-engine
type Variant = { kind: '\ud83d'; value: number } | { kind: '\ude00'; value: string };
function describe(value: Variant): string {
  if (value.kind === '\ud83d') return String(value.value + 1);
  return value.value.toUpperCase();
}
console.log(describe({ kind: '\ud83d', value: 2 }));
console.log(describe({ kind: '\ude00', value: 'low' }));
const keys: Record<'\ud83d' | '\ude00', number> = { '\ud83d': 1, '\ude00': 2 };
console.log(JSON.stringify(keys));
console.log(keys['\ud83d'], keys['\ude00']);
