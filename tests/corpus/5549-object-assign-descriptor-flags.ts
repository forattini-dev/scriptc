const source: any = {};
Object.defineProperty(source, 'a', {
  enumerable: true,
  get() {
    Object.defineProperty(source, 'b', { value: 2, enumerable: true, configurable: true });
    Object.defineProperty(source, 'c', { value: 3, enumerable: false, configurable: true });
    return 1;
  },
});
Object.defineProperty(source, 'b', { value: 2, enumerable: false, configurable: true });
Object.defineProperty(source, 'c', { value: 3, enumerable: true, configurable: true });
const target: any = {};
console.log('before', Object.keys(source).join(','));
Object.assign(target, source);
console.log('after', Object.keys(source).join(','));
console.log(target.a, Object.hasOwn(target, 'b'), target.b, Object.hasOwn(target, 'c'));
