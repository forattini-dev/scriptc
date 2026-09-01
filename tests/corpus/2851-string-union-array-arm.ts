type PrimitiveValue = string | number | boolean | null;

function stringify(value: PrimitiveValue | PrimitiveValue[]): string {
  return String(value);
}

console.log(stringify("alpha"));
console.log(stringify(42));
console.log(stringify(false));
console.log(stringify(null));
console.log(stringify(["alpha", 42, false, null]));
