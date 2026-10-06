"use strict";
module.exports.answer = answer;
const { format } = require("./formatter.cjs");
function answer(value) { return "nested:" + format(value); }
