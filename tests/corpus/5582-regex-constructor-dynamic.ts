const Constructor: any = RegExp;
const first: any = Constructor("a+", "gi");
const same: any = Constructor(first);
const copy: any = new Constructor(first);
const changed: any = new Constructor(first, "m");
console.log("dynamic", first === same, first === copy, copy.source, copy.flags, changed.source, changed.flags);
