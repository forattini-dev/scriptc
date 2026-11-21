const original = [] as const;
const widened: readonly number[] = original;
console.log(widened.length);
