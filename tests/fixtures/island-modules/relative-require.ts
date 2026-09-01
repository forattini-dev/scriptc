// @dynamic
// A CommonJS package whose entry require()s a relative sibling and a JSON
// file: both edges resolve through the island's embedded edge table.
import { describe } from "relcjs";

const out: string = describe(2, 3);
console.log(out);
