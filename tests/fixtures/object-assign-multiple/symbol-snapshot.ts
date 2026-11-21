const oldKey = Symbol('old');
const newKey = Symbol('new');
const source: any = {};
source[oldKey] = 'old';
Object.defineProperty(source, 'a', {
  enumerable: true,
  get() {
    delete source[oldKey];
    source[newKey] = 'new';
    return 1;
  },
});
const target: any = {};
Object.assign(target, source);
console.log(target.a, Object.hasOwn(target, oldKey), Object.hasOwn(target, newKey));
