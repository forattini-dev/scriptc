// @no-engine
const log: string[] = [];
const values: (number | null | undefined)[] = [];
function receiver(): (number | null | undefined)[] { log.push("receiver"); return values; }
function index(): number { log.push("index"); return 2; }
function value(): number | undefined { log.push("value"); return undefined; }
receiver()[index()] = undefined;
console.log(log.join(","), values.length, 2 in values, 0 in values, values[2]);
log.length = 0;
receiver()[index()] = null;
console.log(log.join(","), values.length, 2 in values, values[2]);
log.length = 0;
receiver()[index()] = value();
console.log(log.join(","), values.length, 2 in values, values[2]);
console.log(values.includes(undefined), values.indexOf(undefined), values.indexOf(null));
