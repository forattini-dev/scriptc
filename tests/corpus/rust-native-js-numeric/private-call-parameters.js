// @rust-only
// @no-engine
function findClosestColor(color, palette) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const dr = color[0] - pr;
    const dg = color[1] - pg;
    const db = color[2] - pb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

console.log(
  'closest',
  findClosestColor([9, 8, 7], [[1, 2, 3], [10, 9, 8], [20, 20, 20]]),
);

function combinedAlpha(fg, bg) {
  return bg && bg.a > 0 ? fg.a + bg.a : fg.a;
}
console.log(
  'optional-record',
  Number(combinedAlpha({a: 2})),
  Number(combinedAlpha({a: 2}, {a: 3})),
);

function bestSquare(value) {
  let best = Infinity;
  const square = value * value;
  if (square < best) best = square;
  console.log('widened-local', typeof best);
  return best;
}
bestSquare(2);
bestSquare(2n);

function addFraction(data) {
  data[0] += 1.5;
}
const floatData = new Float32Array([2]);
addFraction(floatData);
console.log('typed-compound', floatData[0]);

function addAtWidth(data, width) {
  data[width - 1] += 2;
}
const frame = {data: new Float32Array([4]), width: 1};
const {data: frameData, width: frameWidth} = frame;
addAtWidth(frameData, frameWidth);
console.log('binding-parameter', frameData[0]);
frameData[0n] += 1;
console.log('bigint-index', frameData[0]);

function addAtDynamic(data, width) {
  data[0 + width] += 1;
}
addAtDynamic(frameData, 0);
addAtDynamic(frameData, '01');
console.log('dynamic-index', frameData[0]);

function writeOffset(data, offset) {
  data[offset] = 9;
}
function writeFromLength(data, length) {
  const observedLength = data.length;
  console.log('typed-length', typeof observedLength);
  writeOffset(data, 0);
  writeOffset(data, length - 1);
}
const offsets = new Uint8Array(2);
writeFromLength(offsets, offsets.length);
console.log('planned-offset', offsets[0], offsets[1]);
