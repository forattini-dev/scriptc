import * as http from "node:http";
import { METHODS, STATUS_CODES, maxHeaderSize } from "node:http";

console.log("methods", METHODS.join("|"));
console.log("namespace", http.METHODS[0], http.METHODS[http.METHODS.length - 1]);
console.log("header limit", maxHeaderSize, http.maxHeaderSize);
console.log("status", STATUS_CODES[200], STATUS_CODES[418], http.STATUS_CODES[511], STATUS_CODES[299] === undefined);
console.log("shared", METHODS === http.METHODS, STATUS_CODES === http.STATUS_CODES);
const originalMethod = METHODS[0]!;
METHODS[0] = "CUSTOM";
console.log("method mutation", http.METHODS[0]);
METHODS[0] = originalMethod;
STATUS_CODES[299] = "Custom";
console.log("status mutation", http.STATUS_CODES[299]);
