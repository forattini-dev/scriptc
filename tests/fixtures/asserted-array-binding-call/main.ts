async function observe(value: number, children: number[]) {
  const promises = children.map(async child => `${value}:${child}`);
  console.log(JSON.stringify([value]), typeof value, value + 1, JSON.stringify(await Promise.all(promises)));
}
async function run(values: number[]) {
  const [parent, ...children] = values;
  await observe(parent!, children);
}
async function main() {
  await run([5, 2]);
  await run([]);
  const hole: number[] = [];
  hole.length = 1;
  await run(hole);
  const missingParent: number[] = [];
  missingParent.length = 2;
  missingParent[1] = 2;
  await run(missingParent);
}
void main();
