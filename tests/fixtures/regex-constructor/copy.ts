const Constructor: any = RegExp;
const original = /a+/gi;
original.lastIndex = 4;
const same: any = Constructor(original, undefined);
const copy: any = new Constructor(original);
console.log("copy", same === original, copy === original, original.lastIndex, copy.lastIndex, copy.source, copy.flags);
