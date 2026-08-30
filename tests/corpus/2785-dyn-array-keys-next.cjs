// @dynamic
"use strict";

const values = JSON.parse("[10,20]");
const iterator = values.keys();

console.log(JSON.stringify(iterator.next()));
console.log(JSON.stringify(iterator.next()));
console.log(JSON.stringify(iterator.next()));
