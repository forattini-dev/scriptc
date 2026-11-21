const root: any = globalThis;
const old = RegExp;
root.RegExp = 17;
console.log("override", (RegExp as any) === root.RegExp, RegExp === old);
