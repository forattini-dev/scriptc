// @rust-only
// @no-engine
import { Cell } from "./library.js";
const cell = new Cell(3);
const alias = cell;
console.log("public", cell.value, (alias.value = 12), cell.value);
