// @rust-only
// @no-engine
const object: { value?: number; untouched: string } = { value: 1, untouched: 'yes' };
const alias = object;
let effects = '';
function changed(): number { effects += 'value'; return 2; }
const result = Object.defineProperty(object, 'value', {
  value: changed(), writable: true, enumerable: true, configurable: true,
});
console.log('identity', result === alias, object.value ?? 0, effects, Object.keys(object).join(','));
result.value = 3;
console.log('write', alias.value ?? 0, object.untouched);
delete object.value;
console.log('delete', Object.keys(alias).join(','));
