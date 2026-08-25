// A coercive Number.parseFloat(any) remains island-backed beside exact
// static controls (Math.sqrt/PI, number precision/radix formatting, and
// string replace/replaceAll/at). A static build reports only the dynamic
// argument site, never an ICE or link error. Exact-string Number.parseFloat,
// Number.parseInt, and their global forms compile natively.
const up = Math.sqrt(2);
const tau = Math.PI * 2;
const price = (19.99).toPrecision(4);
const swapped = "banana".replace("an", "AN");
const ch = "hello".at(0);
const input: any = "3.14";
const n = Number.parseFloat(input);
void n;
