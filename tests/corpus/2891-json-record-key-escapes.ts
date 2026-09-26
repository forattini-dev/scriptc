import { format } from "node:util";

interface EscapedRecord {
  "slash\\key": number;
  'quote"key': number;
  "line\nkey": number;
  "tab\tkey": number;
  "nul\u0000key": number;
  "unit\u001fkey": number;
  "comment*/key": number;
  "unicode-é-😀": number;
}

const required: EscapedRecord = {
  "slash\\key": 1,
  'quote"key': 2,
  "line\nkey": 3,
  "tab\tkey": 4,
  "nul\u0000key": 5,
  "unit\u001fkey": 6,
  "comment*/key": 7,
  "unicode-é-😀": 8,
};
const compact = JSON.stringify(required);
console.log(compact);
console.log(format("%j", required));

const parsed = JSON.parse(compact) as EscapedRecord;
console.log(
  parsed["slash\\key"],
  parsed['quote"key'],
  parsed["line\nkey"],
  parsed["tab\tkey"],
  parsed["nul\u0000key"],
  parsed["unit\u001fkey"],
  parsed["comment*/key"],
  parsed["unicode-é-😀"],
);

interface OptionalEscapedRecord {
  'quote"present'?: number;
  "slash\\required": string;
  "drop\nmissing"?: number;
}
const optional: OptionalEscapedRecord = {
  'quote"present': 8,
  "slash\\required": "ok",
  "drop\nmissing": undefined,
};
console.log(JSON.stringify(optional));

const nested = {
  'outer"\\': {
    "inner\n\t": true,
  },
};
console.log(JSON.stringify(nested, null, 2));
console.log(JSON.stringify([required, nested]));

const indexed: Record<string, number> = {};
indexed['quote"key'] = 9;
indexed["slash\\key"] = 10;
indexed["control\u0001key"] = 11;
console.log(JSON.stringify(indexed));
