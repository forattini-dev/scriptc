// @rust-only
// @no-engine
function useFactory<T>(factory: () => T): T { return factory(); }
const result = useFactory(() => ({ type: "box", props: {}, children: [], key: undefined }));
console.log("callback", result.type, result.children.length, result.key === undefined);
function capture() {
  const state = { key: undefined, child: null, children: [] };
  return () => state;
}
const read = capture();
const first = read();
console.log("capture", read() === first, first.key === undefined, first.child === null, first.children.length);
