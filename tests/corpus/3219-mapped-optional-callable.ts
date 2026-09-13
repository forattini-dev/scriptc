// @rust-only
// @no-engine
// Reconstructed parameter tuples, as in Redcode's ServiceUse mapped type.
type Methods<Shape> = {
  [Key in keyof Shape]: Shape[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result : never;
};
interface Options { prefix: string }
interface Service {
  format(path: string, options?: Options): string;
  size(input?: number): number;
}
const methods: Methods<Service> = {
  format(path: string, options?: Options): string {
    return options === undefined ? path : options.prefix + path;
  },
  size(input: number = 7): number { return input; },
};
console.log(methods.format('a'), methods.format('b', undefined), methods.format('c', { prefix: 'p:' }));
console.log(methods.size(), methods.size(undefined), methods.size(0));
const extracted = methods.format;
console.log(extracted('d'), extracted('e', { prefix: 'q:' }));

function apply(fn: (...args: [path: string, mode?: number]) => string): void {
  console.log(fn('x'), fn('y', undefined), fn('z', 3));
}
apply((path: string, mode?: number) => `${path}:${mode === undefined ? 'none' : String(mode)}`);
