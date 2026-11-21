import { PrivateBox } from './unsupported.js';
const value = new PrivateBox();
const read = value.read;
console.log(read.call(value));
