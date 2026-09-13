// @rust-only
// @no-engine

function read<T>(service: T, key: string): unknown { return service[key as keyof T]; }
function same(left: unknown, right: unknown): boolean { return left === right; }
function callOrSkip(value: unknown): number {
  if (typeof value !== 'function') return -1;
  return (value as () => number)();
}

let value = 11;
const original = () => value;
const replacement = () => 23;
const full = { read: original, label: 'service', extra: 7 };
type Shape = { read: () => number; label: string };
const narrowed: Shape = full;
console.log('extra after narrowing', read(narrowed, 'extra'));
console.log('guards', typeof read(narrowed, 'missing'), callOrSkip(read(narrowed, 'missing')), callOrSkip(read(narrowed, 'label')));

let order = '';
let receivers = 0;
let keys = 0;
function receiver(): Shape {
  receivers++;
  order += 'receiver ';
  return narrowed;
}
function key(): string {
  keys++;
  order += 'key';
  return 'read';
}
const detached = read(receiver(), key());
console.log('evaluation', order, receivers, keys);
console.log('detached', same(detached, original), detached === read(narrowed, 'read'), callOrSkip(detached));
order = '';
receivers = 0;
keys = 0;
const direct: unknown = receiver()[key() as keyof Shape];
console.log('direct evaluation', order, receivers, keys, same(direct, original));
value = 13;
console.log('captured', callOrSkip(detached));
narrowed.read = replacement;
console.log('replacement', same(read(narrowed, 'read'), replacement), same(read(full, 'read'), replacement), callOrSkip(read(narrowed, 'read')), callOrSkip(detached));
full.extra = 9;
console.log('extra mutation', read(narrowed, 'extra'));

const bytes = new Uint8Array([5, 6]);
const payload = { read: original, label: 'bytes', bytes, size: 9007199254740993n };
const selectedBytes = read(payload, 'bytes') as Uint8Array;
console.log('payload', selectedBytes === bytes, (read(payload, 'size') as bigint) === 9007199254740993n);
selectedBytes[0] = 8;
bytes[1] = 10;
console.log('byte mutations', bytes[0], (read(payload, 'bytes') as Uint8Array)[1]);
payload.size = 9007199254740995n;
console.log('bigint replacement', (read(payload, 'size') as bigint) === 9007199254740995n);
const nextBytes = new Uint8Array([21]);
payload.bytes = nextBytes;
console.log('byte replacement', (read(payload, 'bytes') as Uint8Array) === nextBytes, selectedBytes === bytes, selectedBytes[0]);
