type Inventory = { workers: { unit: string }[] };

function inventory(present: boolean): Inventory | undefined {
  return present ? { workers: [{ unit: "one" }, { unit: "two" }] } : undefined;
}

console.log("absent", inventory(false)?.workers.map((worker) => worker.unit) === undefined);
const present = inventory(true)?.workers.map((worker) => worker.unit)!;
console.log("present", present.length, present[0], present[1]);
