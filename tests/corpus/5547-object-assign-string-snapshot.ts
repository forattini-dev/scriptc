const source: any = {};
Object.defineProperty(source, 'a', {
  enumerable: true,
  get() {
    delete source.b;
    source.c = 3;
    return 1;
  },
});
source.b = 2;
const target: any = {};
Object.assign(target, source);
console.log(target.a, Object.hasOwn(target, 'b'), Object.hasOwn(target, 'c'));
