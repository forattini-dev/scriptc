// @rust-only
// @no-engine
const bytes = new Uint8Array([19]);
const index = true ? bytes[8]! : 0;
const alias: any = bytes;
function peek(): void { console.log('peek', String(bytes?.[index!] ?? 42)); }
peek();
alias.undefined = undefined;
console.log('own-undefined', Object.hasOwn(alias, 'undefined'));
alias.undefined = 37;
console.log('keys', Object.keys(alias).join(','), Object.hasOwn(alias, 'undefined'));
peek();
const view = bytes.subarray(0);
const viewAlias: any = view;
viewAlias.undefined = 11;
console.log('view', String(view?.[index!]), String(bytes?.[index!]));
alias.undefined = 'text';
const snapshot = bytes?.[index!];
const snapshotAlias = snapshot;
const selected = bytes?.[index!] ?? 42;
console.log('snapshot', String(snapshotAlias), String(selected));
peek();
alias.undefined = bytes;
console.log('identity', (bytes?.[index!] as any) === bytes);
delete alias.undefined;
console.log('deleted', Object.hasOwn(alias, 'undefined'));
peek();
function cycle(): void { const source = new Uint8Array([1]); const ref: any = source; ref.undefined = source; }
cycle();
