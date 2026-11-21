import { bufferWidth, DoubleBuffer } from './buffer.js';

console.log(new DoubleBuffer(23).getFrontBuffer().width);
console.log(new DoubleBuffer(23).frontWidthViaHelper());
console.log(bufferWidth(new DoubleBuffer(23).getFrontBuffer()));
