function first(value: string, separator: string) { return value.split(separator)[0]!; }
function relay(value: string, separator: string) { return first(value, separator); }
function zero(value: string) { return value.split(' ', 0)[0]!; }
function show(value: unknown) {
  console.log(String(value));
  console.log(typeof value);
  console.log(JSON.stringify([value]));
}
show(relay('hello world', ' '));
show(relay('', ' '));
show(relay('', ''));
show(zero('hello'));
