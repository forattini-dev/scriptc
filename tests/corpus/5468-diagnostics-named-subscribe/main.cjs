"use strict";

const diagnostics = require("node:diagnostics_channel");

const seen = [];
function listener(message, name) {
  seen.push(name + ":" + message);
}

console.log(diagnostics.hasSubscribers("native:test"));
diagnostics.subscribe("native:test", listener);
const channel = diagnostics.channel("native:test");
console.log(diagnostics.hasSubscribers("native:test"), channel.hasSubscribers);
channel.publish("first");
console.log(seen.join("|"));
console.log(diagnostics.unsubscribe("native:test", listener));
console.log(diagnostics.hasSubscribers("native:test"), channel.hasSubscribers);
