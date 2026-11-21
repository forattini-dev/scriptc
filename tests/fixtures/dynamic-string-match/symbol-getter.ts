"use strict";
const events: string[] = [];
const pattern: any = {
  get [Symbol.match]() {
    events.push("get");
    return function(value: string) { events.push("call"); return value + "!"; };
  },
};
const result: any = "abc".match(pattern);
console.log("getter", result, events.join(","));
