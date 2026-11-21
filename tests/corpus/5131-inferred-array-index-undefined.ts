const empty: string[] = [];
const missing = empty[0];
console.log(missing === undefined);

const values: string[] = ["alpha"];
const first = values[0];
console.log(first === "alpha");
console.log(first === undefined);
if (first !== undefined) {
  console.log(first.toUpperCase());
}
