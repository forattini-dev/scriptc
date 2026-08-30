// @dynamic
"use strict";

const values = JSON.parse("[1,2,3]");
const iterator = values.values();

console.log(JSON.stringify(iterator.next()));
