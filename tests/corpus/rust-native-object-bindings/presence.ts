// @rust-only
// @no-engine
export {};
function read(data: {value?: number}): void {
  const {value} = data;
  console.log(value === undefined, value ?? 17);
}
function dictionary(data: Record<string, number>): void {
  const {missing, present: value} = data;
  console.log(missing === undefined, missing ?? 23, value ?? 0);
}
read({});
read({value: 4});
dictionary({present: 9});
