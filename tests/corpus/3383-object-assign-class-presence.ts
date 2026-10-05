// @no-engine
class Options {
  note: string | undefined = "old";
  payload: unknown = undefined;
  count = 0;
}
function copy(target: Options, source: unknown): Options {
  return Object.assign(target, source);
}
const shared: unknown = { count: 1 };
const present = new Options();
console.log(copy(present, { note: undefined, payload: shared }) === present, present.note, present.payload === shared);
const absent = new Options();
console.log(copy(absent, { payload: shared }) === absent, absent.note, absent.payload === shared);
console.log(copy(absent, null) === absent, absent.note, absent.payload === shared);
console.log(copy(absent, undefined) === absent, absent.note, absent.payload === shared);
let order = "";
function target(): Options {
  order += "target,";
  return absent;
}
function source(): unknown {
  order += "source";
  return { count: 7 };
}
copy(target(), source());
console.log(order, absent.count);
