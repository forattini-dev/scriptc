const Constructor: any = RegExp;
const empty: any = new Constructor();
const number: any = new Constructor(42);
const nil: any = new Constructor(null);
console.log("convert", empty.source, empty.flags, number.source, nil.source);
