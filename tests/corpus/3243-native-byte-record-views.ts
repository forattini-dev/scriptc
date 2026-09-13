// @rust-only
// @no-engine
function same(left: unknown, right: unknown): boolean { return left === right; }
const bytes = new Uint8Array([1, 2]);
const full = { data: bytes, size: 9007199254740993n, extra: 'retained' };
const narrow: { data: Uint8Array; size: bigint } = full;
const opaque: unknown = narrow;
const restored = opaque as { data: Uint8Array; size: bigint };
console.log('record', same(restored, full), restored.data === bytes, restored.size === full.size);
restored.data[0] = 7;
restored.size = 9007199254740995n;
console.log('record mutation', bytes[0], full.size === 9007199254740995n, (opaque as { extra: string }).extra);
const nested = { payload: narrow };
const nestedSlot: unknown = nested;
const nestedBack = nestedSlot as { payload: { data: Uint8Array; size: bigint } };
console.log('nested', nestedBack === nested, nestedBack.payload === narrow, nestedBack.payload.data === bytes);

const table: Record<string, { data: Uint8Array }> = { first: { data: bytes } };
const tableSlot: unknown = table;
const tableBack = tableSlot as Record<string, { data: Uint8Array }>;
console.log('table', tableBack === table, tableBack.first.data === bytes);
const second = new Uint8Array([8]);
tableBack.second = { data: second };
table.first.data[1] = 9;
console.log('table mutation', table.second.data === second, tableBack.first.data[1]);
const sizes: Record<string, { size: bigint }> = { first: { size: 9007199254740993n } };
const sizeSlot: unknown = sizes;
const sizeBack = sizeSlot as Record<string, { size: bigint }>;
sizeBack.first.size = 9007199254740995n;
console.log('sizes', sizeBack === sizes, sizes.first.size === 9007199254740995n);

function accept(value: { data: Uint8Array; size: bigint }): boolean { return value.data === bytes && value.size === full.size; }
const call: unknown = accept;
console.log('call', (call as (value: unknown) => boolean)(opaque));
