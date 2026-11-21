const pattern: any = /a(b)?/i;
const yes: any = "A".match(pattern);
const no: any = "zzz".match(pattern);
console.log("regex", yes[0], yes[1], yes.index, yes.input, no === null);
