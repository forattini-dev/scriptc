// @dynamic
"use strict";

const values = JSON.parse("[10,20,30]");
const iterator = values.values();

console.log(JSON.stringify(iterator.next()));
for (const value of iterator) {
  console.log(value);
}
