// @rust-only
// @no-engine
interface Point { x: number; y: number }
function run(): void {
  let order = 0;
  const source = new Int32Array([11]);
  const getArray = (): Int32Array => { order = order + 1; console.log("array", order); return source; };
  const getIndex = (): number => { order = order + 1; console.log("index", order); return 4; };
  const other = (): number => { order = order + 1; console.log("other", order); return 7; };
  const points: Point[] = [];
  points.push({ x: getArray()[getIndex()]!, y: other() });
  for (const point of points) console.log("value", point.x, point.y, order);
}
run();
