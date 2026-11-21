interface Tracker { count: number }
function add(tracker: Tracker | undefined): number { return tracker!.count += 2; }
const tracker: Tracker = { count: 3 };
console.log(add(tracker), tracker.count);
try { add(undefined); } catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
