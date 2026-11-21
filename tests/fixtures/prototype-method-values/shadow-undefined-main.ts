import { ShadowUndefined } from './shadow-undefined.js';
const absent = new ShadowUndefined(false);
const own = new ShadowUndefined(true);
console.log('own', typeof own.read, typeof absent.read, absent.read());
const extracted = own.read;
console.log('extracted', typeof extracted);
