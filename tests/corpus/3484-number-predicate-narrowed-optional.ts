// @no-engine
function validCount(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0;
}
const samples: (number | null | undefined)[] = [3, 0, -1, 1.5, null, undefined, 2 ** 53];
console.log(samples.map((value) => validCount(value)).join(","));
