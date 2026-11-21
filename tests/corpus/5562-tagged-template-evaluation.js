// @ts-nocheck
"use strict";
const events = [];
const owner = {
  get tag() {
    events.push("get tag");
    return function(parts, first, second) {
      events.push(this === owner ? "receiver" : "wrong receiver");
      console.log("values", parts[0], first, second);
    };
  }
};
function value(name) { events.push(name); return name; }
owner.tag`head${value("one")}${value("two")}`;
console.log("order", events.join(","));
