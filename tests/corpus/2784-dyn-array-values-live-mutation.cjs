// @dynamic
"use strict";

const values = JSON.parse("[1]");
const iterator = values.values();

console.log(JSON.stringify(iterator.next()));
values.push(2);
console.log(JSON.stringify(iterator.next()));
