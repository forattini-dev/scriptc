const token = Symbol('native');
function erase(input: symbol): unknown { return input; }
const value = erase(token);
const mode = process.argv[2] ?? '';
switch (mode) {
  case 'root': JSON.stringify(value); break;
  case 'root-indent': JSON.stringify(value, null, 2); break;
  case 'identity-replacer': JSON.stringify(value, (_key: string, item: unknown) => item); break;
  case 'returned-symbol': JSON.stringify(7, (_key: string, _item: unknown) => value); break;
  default: throw new Error('unknown test mode');
}
console.log('unexpected-success');
