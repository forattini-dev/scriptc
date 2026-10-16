// @rust-only
// @no-engine
console.log("hoisted", factorial(6), even(9));
function factorial(n: number): number {
  if (n <= 1) { return 1; }
  return n * factorial(n - 1);
}
function even(n: number): boolean {
  if (n === 0) { return true; }
  return odd(n - 1);
}
function odd(n: number): boolean {
  if (n === 0) { return false; }
  return even(n - 1);
}
function echo(text: string): string {
  text = "ação 😀";
  return text;
}
function choose(flag: boolean, a: number, b: number): number {
  if (flag) { return a; } else { return b; }
}
function announce(value: number): void {
  if (value < 0) { return; }
  console.error("announced", value);
}
function step(value: number): number {
  console.log("step", value);
  return value;
}
const text = "original";
console.log(echo(text));
console.log(text);
console.log("choose", choose(true, step(2), step(3)));
announce(-1);
announce(factorial(3));
{
  const factorial: number = 8;
  console.log("shadow", factorial);
}
