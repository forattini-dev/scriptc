"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
  return (mod && mod.__esModule) ? mod : { "default": mod };
};
const net_1 = __importDefault(require("net"));
console.log("native default", net_1.default.isIP("127.0.0.1") === 4);
console.log("families", net_1.default.isIPv4("127.0.0.1"), net_1.default.isIPv6("::1"), net_1.default.isIP("invalid"));
