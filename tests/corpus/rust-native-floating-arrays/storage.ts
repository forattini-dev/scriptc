// @ts-nocheck
// @rust-only
// @no-engine
export {};

import { Buffer } from 'node:buffer';
const owner = new Float32Array([257.5, -1, 0.1]);
const record = { samples: owner };
const map = new Map<string, Float32Array>();
map.set('samples', owner);
const fromMap = map.get('samples');
if (fromMap !== undefined) {
  fromMap[2] = 0.25;
  console.log('map', fromMap === owner, record.samples[2]);
}
const erased: any = owner;
console.log('erased', String(erased.length), String(erased.byteLength), Buffer.isBuffer(owner));
console.log('buffer', Buffer.from(owner).join(','), owner.join(','));
const copy = new Float64Array(owner);
console.log('array', [owner, owner][1][2], copy[2]);
