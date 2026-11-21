const Constructor: any = RegExp;
const events: string[] = [];
function arg(value: string): string { events.push(value); return value; }
const result: any = new Constructor(arg("a"), arg("g"), arg("ignored"));
console.log("evaluation", result.source, result.flags, events.join(","));
