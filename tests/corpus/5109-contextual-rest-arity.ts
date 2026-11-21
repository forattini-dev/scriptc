const count: (first?: number, second?: string) => number = (...args) => args.length;
console.log(count());
console.log(count(undefined));
console.log(count(undefined, undefined));
console.log(count(3, "value"));
const alias = count;
console.log(alias());
console.log(alias(2));
const forward: (first?: number, second?: string) => number = (...args) => count(...args);
console.log(forward());
console.log(forward(undefined));
const later: (first?: number) => Promise<number> = async (...args) => args.length;
const adopted: (first?: number) => Promise<number> = async (...args) => later(...args);
async function main(): Promise<void> {
  const values = await Promise.all([later(), later(undefined), later(3), adopted(), adopted(undefined)]);
  console.log(values.join(","));
}
void main();
