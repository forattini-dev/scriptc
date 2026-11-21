interface Tracker { count: number; keywords: Set<string>; totals: Map<string, number> }
let calls = 0;
function next(): number { calls++; return 3; }
function add(tracker?: Tracker): number { return tracker!.count += next(); }
const tracker: Tracker = { count: 2, keywords: new Set(), totals: new Map() };
console.log('present', add(tracker), tracker.count, calls);
try { add(); } catch (error) { console.log('missing', error instanceof TypeError, (error as Error).message, calls); }
console.log('again', add(tracker), tracker.count, calls);
