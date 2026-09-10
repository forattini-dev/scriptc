let order = "";
function source(): string[] { order += "source;"; return ["value"]; }
function index(value: number): number { order += "index;"; return value; }
function receive(value: string | undefined): void { order += "receive;"; console.log(value ?? "missing"); }
receive(source()[index(1)]);
receive(source()[index(0)]);
receive(source()[index(-1)]);
receive(source()[index(0.5)]);
console.log(order);
const argv: string[] = ["--field"];
function looksLikeValue(value: string | undefined): boolean { return value !== undefined && value.length > 0; }
console.log(looksLikeValue(argv[1]));
function optionalReturn(): string | undefined { return argv[1]; }
console.log(optionalReturn() === undefined);

function receiveUnknown(value: unknown): void { console.log(value === undefined); }
receiveUnknown(argv[1]);
