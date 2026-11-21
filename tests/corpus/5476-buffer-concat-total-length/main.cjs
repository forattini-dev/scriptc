"use strict";

const chunks = [Buffer.from([1, 2]), Buffer.from([3])];
console.log(Buffer.concat(chunks, 5).toString("hex"));
console.log(Buffer.concat(chunks, 2).toString("hex"));
const empty = Buffer.concat([], -1);
console.log(empty.length);
console.log(Buffer.isBuffer(empty));
