// @rust-only
// @no-engine
const token = Symbol('native');
function erase(input: symbol): unknown { return input; }
const value = erase(token);
function check(label: string, convert: () => string): void {
  try { console.log(label, convert()); }
  catch (error) { console.log(label, error instanceof TypeError); }
}
check('typed', () => String(token));
check('dynamic', () => String(value));
check('empty', () => String(erase(Symbol())));
check('empty-description', () => String(erase(Symbol(''))));
check('template', () => `${value}`);
const array: unknown = [value];
check('array', () => String(array));
const object: unknown = { toString: () => token };
check('object-hook', () => String(object));
function union(flag: boolean): symbol | string { return flag ? token : 'text'; }
check('union-symbol', () => String(union(true)));
check('union-string', () => String(union(false)));
