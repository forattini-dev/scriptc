class Base { a: number = 1; }
class Child extends Base { b: number = 2; }
const child = new Child();
console.log("initial", Object.keys(child as any).join(","), child.a, child.b);
delete (child as any).a;
(child as any).a = 3;
console.log("reinsert", Object.keys(child as any).join(","), child.a, child.b);
