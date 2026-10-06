"use strict";
console.log("whole init");
module.exports = answer;
const { format } = require("./formatter.cjs");
function answer(value) { return "whole:" + format(value); }
