function report(value: any): void {
  console.log(typeof value); console.log(value === undefined); console.log(String(value)); console.log(value);
}
const popPresent: number[] = [7]; const a = popPresent.pop()!;
const popEmpty: number[] = []; const b = popEmpty.pop()!;
const popUndefined: (number | undefined)[] = [undefined]; const c = popUndefined.pop()!;
const popHole: number[] = []; popHole.length = 1; const d = popHole.pop()!;
const shiftPresent: number[] = [7]; const e = shiftPresent.shift()!;
const shiftEmpty: number[] = []; const f = shiftEmpty.shift()!;
const shiftUndefined: (number | undefined)[] = [undefined]; const g = shiftUndefined.shift()!;
const shiftHole: number[] = []; shiftHole.length = 1; const h = shiftHole.shift()!;
report(a); report(b); report(c); report(d); report(e); report(f); report(g); report(h);
function recordConsumer(entry: { id: number }): number { return entry.id; }
const queue = [{ id: 12 }];
while (queue.length > 0) { const entry = queue.shift()!; console.log(recordConsumer(entry)); }
