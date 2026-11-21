const fn: any = unescape;
console.log("value", fn("%41"), fn("%u0042"), typeof fn);
