// @rust-only
// @no-engine

function display(value: number | undefined): string | undefined {
  return value?.toString();
}

console.log(display(12));
console.log(display(undefined));
