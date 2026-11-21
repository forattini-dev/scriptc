import { gzipSync, gunzipSync } from 'node:zlib';

const source = Buffer.from([0, 255, 65, 10, 0]);
const compressed = gzipSync(source);
console.log(Buffer.isBuffer(compressed), compressed.toString('hex'));
const restored = gunzipSync(compressed);
console.log(Buffer.isBuffer(restored), restored.toString('hex'), restored.equals(source));
