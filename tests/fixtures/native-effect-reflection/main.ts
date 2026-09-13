import { Effect } from 'effect';

// These operations intentionally exceed native reference transport. Keep the
// source checked-dynamic so each case reaches the runtime boundary, not a
// frontend refusal or a structural cast that reflects the handle first.
function opaque(value: unknown): unknown { return value; }
const value: unknown = opaque(Effect.succeed(1));
if (typeof value !== 'object' || value === null) throw new Error('expected an opaque object');
const mode = process.argv[2] ?? '';

switch (mode) {
  case 'json-root-replacer':
    JSON.stringify(value, (_key: string, item: unknown) => {
      console.log('replacer-ran');
      return item === value;
    });
    break;
  case 'json-nested-replacer':
    JSON.stringify({ nested: value }, (key: string, item: unknown) => {
      console.log(key === '' ? 'root-replacer' : 'nested-replacer');
      return item;
    });
    break;
  case 'assign-source':
    Object.assign({}, value);
    break;
  case 'assign-target':
    Object.assign(value, { extra: 1 });
    break;
  case 'has-own':
    console.log(Object.hasOwn(value, '~effect/Effect/args'));
    break;
  case 'in-literal':
    console.log('~effect/Effect/args' in value);
    break;
  case 'in-computed': {
    const key: string = process.argv[3] ?? '~effect/Effect/args';
    console.log(key in value);
    break;
  }
  default:
    console.log('unexpected-mode');
    process.exit(2);
}
console.log('unexpected-success');
