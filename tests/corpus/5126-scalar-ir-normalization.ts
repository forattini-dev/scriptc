let calls = 0;
function numberValue(): number { calls++; return -0; }
function stringValue(): string { calls++; return "scalar"; }
function boolValue(): boolean { calls++; return false; }
console.log(Object.is((numberValue() as any) as number, -0));
console.log((stringValue() as any) as string);
console.log((boolValue() as any) as boolean);
console.log(calls);
try {
  console.log((((): number => { calls++; throw new Error("stop"); })() as any) as number);
} catch (error) { console.log("caught", calls); }
