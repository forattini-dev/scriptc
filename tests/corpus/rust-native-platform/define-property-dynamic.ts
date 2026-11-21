// @rust-only
// @no-engine
function define(object: any): any {
  return Object.defineProperty(object, 'value', {
    value: 'defined', writable: true, enumerable: true, configurable: true,
  });
}
const object: any = { original: 'first' };
const alias: any = object;
const result: any = define(object);
console.log('identity', result === alias, result.value as string, Object.keys(alias).join(','));
alias.value = 'changed';
console.log('write', result.value as string);
delete result.value;
console.log('delete', Object.keys(object).join(','));
