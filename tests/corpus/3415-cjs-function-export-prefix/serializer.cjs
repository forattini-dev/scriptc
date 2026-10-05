"use strict";
module.exports = serialize;
const { format } = require("./formatter.cjs");
const { prefix } = require("./prefix.cjs");
function serialize(value) {
  return prefix + format(value);
}
