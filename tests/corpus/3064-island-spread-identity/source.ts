const shared = { count: 1 };
const symbol = Symbol('kept');
let reads = '';
export function makeSource(): any {
  reads = '';
  const source = Object.create({ inherited: 99 });
  Object.defineProperty(source, 'hidden', { value: 5 });
  source['2'] = 'index';
  source.nested = shared;
  source.bytes = new Uint8Array([7, 8]);
  Object.defineProperty(source, 'first', {
    enumerable: true,
    get() { reads += 'first;'; delete source.removed; return 3; },
  });
  source.removed = 8;
  Object.defineProperty(source, '__proto__', { value: shared, enumerable: true });
  source[symbol] = shared;
  return source;
}
export function inspectCopy(copy: any, source: any): string {
  return JSON.stringify({
    keys: Object.keys(copy), reads,
    nested: copy.nested === shared,
    bytes: copy.bytes === source.bytes,
    symbol: copy[symbol] === shared,
    proto: Object.getPrototypeOf(copy) === Object.prototype,
    ownProto: Object.prototype.hasOwnProperty.call(copy, '__proto__'),
    protoValue: copy.__proto__ === shared,
    first: copy.first, after: copy.after,
    hidden: 'hidden' in copy, inherited: 'inherited' in copy,
    removed: 'removed' in copy,
  });
}
export function mutate(copy: any): string {
  copy.nested.count = 12;
  copy.bytes[0] = 9;
  return `${shared.count}:${copy.bytes[0]}`;
}
let events = '';
export function makeProxy(): any {
  events = '';
  const target: any = { first: 1, removed: 2 };
  Object.defineProperty(target, 'hidden', { value: 3, configurable: true });
  return new Proxy(target, {
    ownKeys() { events += 'keys;'; return ['first', 'removed', 'hidden']; },
    getOwnPropertyDescriptor(object, key) {
      events += `descriptor:${String(key)};`;
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
    get(object, key) {
      events += `get:${String(key)};`;
      if (key === 'first') delete object.removed;
      return Reflect.get(object, key);
    },
  });
}
export function proxyReport(value: any): string {
  return JSON.stringify(value) + ':' + events;
}
