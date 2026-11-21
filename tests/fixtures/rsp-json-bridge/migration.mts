import {encode,type JsonValue} from './index.mjs';
export function encodeSnapshotToon(value:JsonValue):string { return encode(value,{flag:true}); }
