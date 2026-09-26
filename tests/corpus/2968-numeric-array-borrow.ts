// Borrow direct bindings only while index evaluation preserves their owner.
const globalValues = [3, 5, -0];
let globalIndex = 0;
console.log("global", globalValues[globalIndex++] + globalValues[globalIndex], globalIndex);
console.log("signed-zero", 1 / (globalValues[2] * 1));

function localReads(values: number[]): void {
  let index = 0;
  const alias = values;
  const indices = new Uint8Array([1, 0]);
  console.log("local", values[index++] + values[index], index);
  console.log("assign-index", values[index = 0] * 2, index);
  console.log("bytes-index", values[indices[0]] + 1);
  console.log("nested", values[values[0] - 3] + 1);
  values = [90];
  console.log("alias", alias[0] + values[0]);
}
localReads([3, 5]);

let current = [11];
const replacement = [70];
console.log("replace-global", current[(current = replacement) ? 0 : 0] + 1, current[0]);

function replaceLocal(): void {
  let values = [13];
  const replacement = [80];
  console.log("replace-local", values[(values = replacement) ? 0 : 0] * 2, values[0]);
  values = [17];
  const indices = new Uint8Array([0]);
  console.log("replace-nested", values[indices[(values = replacement) ? 0 : 0]] + 1, values[0]);
}
replaceLocal();

function captured(): void {
  let values = [19];
  function read(): number { return values[0] + 1; }
  function replace(): number { values = [100]; return 0; }
  console.log("captured", read(), values[replace()] + 1, read());
}
captured();

function indexTdz(): void {
  function read(values: number[]): number { return values[index] + 1; }
  try { console.log(read([23])); } catch (e) { console.log("index-tdz", (e as Error).name); }
  const index = 0;
  console.log("after-tdz", read([23]));
}
indexTdz();

function consume(values: number[]): number { return values[0] + 1; }
console.log("owned-argument", consume([29]));
console.log("temporary", [31][0] + 1);
console.log("conditional", (globalIndex > 0 ? [37] : [41])[0] + 1);
