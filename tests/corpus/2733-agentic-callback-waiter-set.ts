const waiters = new Set<() => void>();
const events: string[] = [];

const first = (): void => {
  waiters.delete(first);
  events.push("first");
};
const second = (): void => {
  waiters.delete(second);
  events.push("second");
};

waiters.add(first);
waiters.add(first);
waiters.add(second);
console.log("registered", waiters.size);
console.log("removed", waiters.delete(first), waiters.size);

const current = [...waiters];
waiters.clear();
for (const resolve of current) resolve();

console.log("woke", events.join(","), waiters.size);

const lingering = (): void => {
  if (waiters.size === 0) events.push("empty");
};
waiters.add(lingering);
