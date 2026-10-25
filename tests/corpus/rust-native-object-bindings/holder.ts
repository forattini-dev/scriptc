// @rust-only
// @no-engine
// @ts-nocheck
export {};
function check(): void {
  const parsed = JSON.parse('{"ok":true}');
  const rootHolder = {"": parsed};
  const stack = [{parent: rootHolder, key: "", visited: true}];
  const node = stack[stack.length - 1];
  const {parent, key} = node;
  const value = parent[key];
  console.log("holder", parent === rootHolder, key === "", value === parsed, value.ok === true);
  value.ok = false;
  console.log("alias", parsed.ok === false);
}
check();
