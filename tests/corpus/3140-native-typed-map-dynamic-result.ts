// @no-engine
class Entry {
  value: number;
  constructor(value: number) { this.value = value; }
}

const first = new Entry(2);
const second = new Entry(3);
const entries: Entry[] = [first, second];
const one = entries.map((entry): unknown => {
  console.log("identity", entry === first || entry === second);
  entry.value += 10;
  return entry.value;
});
console.log("one", JSON.stringify(one), first.value, second.value);
console.log("zero", JSON.stringify(entries.map((): unknown => "constant")));
console.log("two", JSON.stringify(entries.map((entry, index): unknown => entry.value + index)));
console.log("three", JSON.stringify(entries.map((entry, index, source): unknown => {
  console.log("source", source === entries, index);
  if (index === 0) {
    source[1] = new Entry(40);
    source.push(new Entry(90));
  }
  return entry.value;
})));
console.log("after", entries.length, entries[1].value);

// Boxable records must retain callback mutations too, without snapshots.
const record = { value: 1 };
console.log("record", JSON.stringify([record].map((item): unknown => {
  item.value = 8;
  return item.value;
})), record.value);

let visits = 0;
try {
  entries.map((entry): unknown => {
    visits++;
    if (entry.value === 40) throw new Error("stop mapping");
    return entry.value;
  });
} catch (error) {
  if (error instanceof Error) console.log("throw", error.message, visits);
}
const empty: Entry[] = [];
console.log("empty", JSON.stringify(empty.map((): unknown => { visits++; return 0; })), visits);

let order = "";
function receiver(): Entry[] { order += "receiver;"; return [first]; }
function callback(): (entry: Entry) => unknown {
  order += "callback;";
  return (entry): unknown => { order += "visit;"; return entry.value; };
}
console.log("order", JSON.stringify(receiver().map(callback())), order);

const tuple: readonly [number, number] = [4, 5];
console.log("tuple", JSON.stringify(tuple.map((value, index): unknown => value + index)));
