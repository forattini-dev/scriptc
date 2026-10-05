"use strict";
const data = require("./data.json");
data.version = "before";
data.nested.count = 9;
const snapshot = require("./snapshot.cjs");
data.version = "after";
data.nested.count = 12;
console.log(snapshot.describe());
console.log(data.version, data.nested.count);
