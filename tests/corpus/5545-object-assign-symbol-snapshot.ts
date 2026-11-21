const removed = Symbol('removed');
const added = Symbol('added');
const retained = Symbol('retained');
const source: any = {};
source[removed] = 'old';
source[retained] = 'keep';
Object.defineProperty(source, 'a', {
  enumerable: true,
  get() {
    delete source[removed];
    source[added] = 'new';
    source[retained] = 'changed';
    return 1;
  },
});
const target: any = {};
Object.assign(target, source);
console.log(target.a, Object.hasOwn(target, removed), Object.hasOwn(target, added), target[retained]);
