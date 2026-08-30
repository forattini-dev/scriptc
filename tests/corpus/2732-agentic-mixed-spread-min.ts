function expirations(): number[] {
  console.log("expirations");
  return [31, 8, 19];
}

function limit(name: string, value: number): number {
  console.log(name);
  return value;
}

console.log("next", Math.min(...expirations(), limit("safety", 12), limit("remaining", 7)));

const none: number[] = [];
console.log("empty", Math.min(...none, 5, 9));
