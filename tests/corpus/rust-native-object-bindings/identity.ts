// @rust-only
// @no-engine
export {};
function check(): void {
  const child = {value: 1};
  const callback = (n: number): number => n + child.value;
  const data = {child, callback};
  const {child: alias, callback: fn} = data;
  console.log(alias === child, fn === callback, fn(3));
  alias.value = 7;
  console.log(data.child.value, fn(3), data.callback === fn);
  const get = (): number => alias.value;
  console.log(get());
  const method = function(this: any): any { return this; };
  const object = {method};
  const {method: detached} = object;
  console.log("receiver", detached === method, object.method() === object, detached() === undefined);
}
check();
