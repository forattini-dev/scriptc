const sparse: Array<number | undefined> = [];
sparse.length = 4;
sparse[1] = 7;
sparse[2] = undefined;
const spread: any[] = [...sparse];
console.log('spread', spread.length, Object.hasOwn(spread, '0'), Object.hasOwn(spread, '1'), Object.hasOwn(spread, '2'), Object.hasOwn(spread, '3'), spread[0], spread[1], spread[2], spread[3]);
const optional: Array<number | undefined> = [...sparse];
console.log('optional', optional.length, Object.hasOwn(optional, '0'), Object.hasOwn(optional, '2'), optional[0], optional[1], optional[2]);
function collect(...values: any[]): any[] { return values; }
const rest = collect(...sparse);
console.log('rest', rest.length, Object.hasOwn(rest, '0'), Object.hasOwn(rest, '1'), Object.hasOwn(rest, '2'), Object.hasOwn(rest, '3'), rest[0], rest[1], rest[2], rest[3]);
const numeric: number[] = [];
numeric.length = 3;
numeric[1] = 5;
console.log('numeric', JSON.stringify(collect(...numeric)));
const live: number[] = [1, 2];
function append(): number { live.push(3); return 4; }
const ordered: any[] = [...live, append()];
console.log('order', JSON.stringify(ordered), JSON.stringify(live));
