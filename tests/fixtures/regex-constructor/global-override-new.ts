const root: any = globalThis;
root.RegExp = function() { return { custom: true }; };
const value: any = new RegExp("x");
console.log("override-new", value.custom);
