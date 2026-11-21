const tuples: [number, string][] = [[1, "ready"]];
const arrays: unknown[][] = tuples;

arrays[0][0] = 2;
console.log(tuples[0][0]);
