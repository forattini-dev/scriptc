let count = 0;
export function calls() { return count; }
export function makePlan(options) {
  count++;
  return {width: options.value, fit: "contain", active: true, nested: {value: options.value}};
}
