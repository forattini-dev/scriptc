"use strict";
const { version, nested } = require("./data.json");
function describe() {
  return `${version}:${nested.count}`;
}
module.exports = { describe };
