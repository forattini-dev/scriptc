// @rust-only
// @no-engine
export {};
const text = "abc";
let index = 9;
const missing = text[index];
const alias = missing;
const present = text[0];
function read(): void { console.log("module", missing === undefined, missing ?? "fallback", present ?? "fallback", alias === undefined); }
read();
function local(input: string, index: number): void {
  const value = input[index];
  const capture = (): string | undefined => value;
  console.log("local", value === undefined, value ?? "fallback", capture() === value);
  if (value !== undefined) console.log("guard", value.toUpperCase());
}
local("ab", 0);
local("ab", 9);
