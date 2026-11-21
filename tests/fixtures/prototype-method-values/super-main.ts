import { SuperChild } from './unsupported.js';
const value = new SuperChild();
const read = value.read;
console.log(read.call(value));
