// @rust-only
// @no-engine
const counts = new Map<string, (...args: unknown[]) => number>();
counts.set('count', (...args: unknown[]) => args.length);
const count = counts.get('count');
if (count !== undefined) console.log(count() + count('a', 'b') * 2);
const predicates = new Map<string, (...args: unknown[]) => boolean>();
predicates.set('has', (...args: unknown[]) => args.length > 0);
const has = predicates.get('has');
if (has !== undefined) console.log(!has(), has(1) && has(2));
const big = new Map<string, (...args: unknown[]) => bigint>();
big.set('big', (...args: unknown[]) => 9007199254740993n + BigInt(args.length));
const read = big.get('big');
if (read !== undefined) console.log(Number(read()), read('x') - 9007199254740993n);
// The native DataView Number(...) operation fuses this conversion already.
const bytes = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]);
const view = new DataView(bytes.buffer);
console.log(Number(view.getBigUint64(0)), Number(view.getBigInt64(0)));
