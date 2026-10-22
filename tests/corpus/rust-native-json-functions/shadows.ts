// @rust-only
// @no-engine
function custom(): boolean {
  const JSON = {stringify: (value: number): string => "custom", parse: (value: string): number => 99};
  return JSON.stringify(1) === "custom" && JSON.parse("1") === 99;
}
console.log("shadow", custom());

const original = JSON.stringify;
let current = original;
console.log("mutable", current({ok: true}) === '{"ok":true}');
function encode(callback: typeof JSON.stringify, input: any): unknown { return callback(input); }
console.log("parameter", encode(original, {value: 1}) === '{"value":1}');
