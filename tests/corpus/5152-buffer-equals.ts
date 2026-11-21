/// <reference types="node" />

const bytes = Buffer.from([0, 255, 128, 10]);
const same = Buffer.from([0, 255, 128, 10]);
const different = Buffer.from([0, 255, 128, 11]);

console.log(bytes.equals(same), bytes.equals(different));
