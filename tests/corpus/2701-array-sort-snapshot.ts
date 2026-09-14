const receiver = [3, 1, 2];
const returned = receiver.sort((a, b) => a - b);
console.log(returned === receiver, receiver.join(","), returned.join(","));

const mutatedReceiver = [3, 1, 2];
let changedReceiver = false;
mutatedReceiver.sort((a, b) => {
  if (!changedReceiver) {
    changedReceiver = true;
    mutatedReceiver[0] = 99;
  }
  return a - b;
});
console.log(mutatedReceiver.join(","));

const source = [3, 1, 2];
let changed = false;
const sorted = source.toSorted((a, b) => {
  if (!changed) {
    changed = true;
    source[0] = 99;
    source.push(4);
  }
  return a - b;
});
console.log(sorted.join(","));
console.log(source.join(","));

const stable = [
  { key: "b", order: 1 },
  { key: "a", order: 2 },
  { key: "b", order: 3 },
  { key: "a", order: 4 },
];
const byKey = stable.toSorted((a, b) => a.key.localeCompare(b.key));
console.log(byKey.map((entry) => entry.order).join(","));
console.log(stable.map((entry) => entry.order).join(","));

const throwing = [3, 1, 2];
try {
  throwing.sort((a, b): number => {
    throw new Error("stop");
  });
} catch (error) {
  console.log(error instanceof Error, throwing.join(","));
}
