// @rust-only
// @no-engine
function token(value: string): string { console.log("token", value); return value; }
const red = { 400: token("red.400"), 500: token("red.500"), 600: token("red.600") };
console.log("red", red[400], red["500"]);
const alias = red;
alias[500] = "changed";
console.log("red", red[500]);
const forms = { 0x10: "hex", 1e2: "exponent", 1_000: "separator", 0: "zero", 1e21: "large", 1e-7: "small" };
console.log("forms", forms[16], forms[100], forms[1000], forms[-0], forms["1e+21"], forms["1e-7"]);
const erased: unknown = { 400: "dynamic", 0x10: "hex" };
console.log((erased as any)[400] === "dynamic", (erased as any)[16] === "hex");
const dictionary: { [key: string]: string } = { 400: "dictionary" };
dictionary[500] = "written";
console.log("dictionary", dictionary[400], dictionary[500]);

const ordered = { 600: token("first"), 400: token("second"), 500: token("third") };
function receiver(): typeof ordered { console.log("write", "receiver"); return ordered; }
function value(): string { console.log("write", "value"); return "updated"; }
receiver()[400] = value();
console.log("order", ordered[400], ordered[500], ordered[600]);
const rounded = { 9007199254740993: "rounded", 1e-6: "decimal" };
console.log("rounding", rounded[9007199254740992], rounded["0.000001"]);
