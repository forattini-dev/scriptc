function show(refs: { propertyPath?: any[] }) {
  console.log("path", refs.propertyPath?.toString());
}

const path: any[] = ["one", "two"];
show({ propertyPath: path });
(path as any).join = () => "custom join";
show({ propertyPath: path });
console.log("own", Object.hasOwn(path, "join"), Object.keys(path).join("|"));
const descriptor = Object.getOwnPropertyDescriptor(path, "join");
console.log("descriptor", descriptor?.writable, descriptor?.enumerable, descriptor?.configurable);
console.log("reflect", Reflect.ownKeys(path).join("|"));
console.log("method", (path as any).join());
(path as any).join = function (this: any[]) {
  return this === path ? "receiver true" : "receiver false";
};
show({ propertyPath: path });
(path as any).join = 17;
show({ propertyPath: path });
(path as any).toString = () => "custom toString";
show({ propertyPath: path });
(path as any).toString = () => 42;
show({ propertyPath: path });
(path as any).toString = 17;
try {
  show({ propertyPath: path });
} catch (error) {
  console.log("not callable", error instanceof TypeError);
}
delete (path as any).toString;
delete (path as any).join;
console.log("deleted", Object.hasOwn(path, "join"), Object.keys(path).join("|"));
show({ propertyPath: path });
