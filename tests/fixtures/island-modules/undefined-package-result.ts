import { parseErrors } from "optionszoo";

const missing = parseErrors().errors.find(() => true);
console.log(missing === undefined);
