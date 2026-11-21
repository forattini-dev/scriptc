// @rust-only
// @no-engine

function choose(flag: boolean): string[] | number[] {
  const left: string[] = ["left", "right"];
  const right: number[] = [3, 5];
  return flag ? left : right;
}

const strings = [...choose(true)];
const numbers = [...choose(false)];
console.log(strings.join("|"));
console.log(numbers.join("|"));
