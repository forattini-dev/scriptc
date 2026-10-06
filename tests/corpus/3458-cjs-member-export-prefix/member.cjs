"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.answer = answer;
const { format } = require("./formatter.cjs");
function answer(value) { return "member:" + format(value); }
