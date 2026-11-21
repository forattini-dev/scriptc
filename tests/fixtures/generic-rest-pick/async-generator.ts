export {};
async function first<T>(...values: T[]): Promise<T> { await Promise.resolve(); return values[0]; }
function* entries<T>(...values: T[]): Generator<T> { for (const value of values) yield value; }
const object = { n: 7 };
async function run(): Promise<void> {
  console.log('async', await first(1, 2), await first('a', 'b'), await first(object) === object);
  for (const value of entries(1, 2)) console.log('generator', value);
  for (const value of entries('a', 'b')) console.log('generator', value);
  for (const value of entries(object)) console.log('generator identity', value === object);
}
run();
