import { answer, type Row } from "typed-value";

const row: Row = { value: answer(), label: "native" };
console.log(row.label, row.value * 2);
