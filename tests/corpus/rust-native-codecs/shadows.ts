// @rust-only
// @no-engine
export {};
class TextEncoder { value: number = 7; encode(text: string): string { return text + " local"; } }
class TextDecoder { decode(): string { return "own decoder"; } }
class Uint8Array { value: number = 9; }
const encoder = new TextEncoder();
console.log("shadow", encoder.value, encoder.encode("own"), new TextDecoder().decode(), new Uint8Array().value);
