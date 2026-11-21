const root: any = globalThis;
const old = unescape;
console.log("global", root.unescape === unescape, typeof old, old("%41"));
root.unescape = 17;
console.log("override", (unescape as any) === 17, old === root.unescape);
