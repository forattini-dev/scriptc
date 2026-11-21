interface Tracker { count: number; keywords: Set<string>; totals: Map<string, number> }
let current: Tracker | undefined = { count: 2, keywords: new Set(), totals: new Map() };
let rightCalls = 0;
function right(): number { rightCalls++; return 3; }
function maybeClear(clear: boolean): void { if (clear) current = undefined; }
function update(clear: boolean): void {
  if (current) {
    maybeClear(clear);
    current.count += right();
  }
}
update(false);
console.log('present', current?.count, rightCalls);
try { update(true); } catch (error) { console.log('cleared', error instanceof TypeError, (error as Error).message, rightCalls); }
