// @rust-only
// @no-engine
interface Point { x: number; y: number; }
function observe(point: Point): void {
  console.log("observed", point.x, point.x === undefined, point.x + 1, point.y);
  console.log("keys", Object.keys(point).join(","));
  point.x = 9;
}
function run(index: number): void {
  const values = new Int32Array([4, 5]);
  const points: Point[] = [];
  const alias = points;
  alias.push({ x: values[index]!, y: values[0]! });
  for (const point of alias) {
    observe(point);
    console.log("alias", point.x, point.y);
  }
}
run(0);
run(4);
