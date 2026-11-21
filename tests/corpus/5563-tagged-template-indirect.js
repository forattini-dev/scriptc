// @ts-nocheck
"use strict";

const calls = [];
const sites = [];
const code = {
  tag(strings, ...args) {
    calls.push(this === undefined ? "indirect" : "receiver");
    sites.push(strings);
    return [strings[0], ...args, strings[1], strings.raw[0]].join("|");
  },
};
function value() {
  calls.push("value");
  return 7;
}
function run() {
  return (0, code.tag)`line\n${value()}!`;
}
console.log(run());
console.log(run());
console.log("identity", sites[0] === sites[1], sites[0].raw === sites[1].raw);
console.log("order", calls.join(","));
