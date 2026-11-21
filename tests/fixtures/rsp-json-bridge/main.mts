import {encodeSnapshotToon} from './migration.mts';
import type {JsonObject,JsonValue} from './index.mjs';
const a={x:1};const b={y:'a'};
console.log(encodeSnapshotToon(a as unknown as JsonObject));
console.log(encodeSnapshotToon(b as unknown as JsonObject));
console.log('undefined:'+encodeSnapshotToon(undefined as unknown as JsonValue));
