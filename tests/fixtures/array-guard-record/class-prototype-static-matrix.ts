class Parent {
  value: number;
  constructor() { this.value = 1; }
  read() { return this.value; }
}
class Child extends Parent {}

for (let mode = 0; mode < 8; mode++) {
  delete (Parent as any).constructor;
  delete (Parent as any).marker;
  delete (Parent.prototype as any).marker;
  Object.defineProperty(Parent.prototype, 'constructor', { value: Parent, writable: true, configurable: true, enumerable: false });
  if (mode === 1) (Parent as any).constructor = Child;
  if (mode === 2) (Parent.prototype as any).constructor = Child;
  if (mode === 3) { (Parent as any).constructor = 7; (Parent.prototype as any).constructor = Child; }
  if (mode === 4) delete (Parent.prototype as any).constructor;
  if (mode === 5) Object.defineProperty(Parent.prototype, 'constructor', { get() { return Child; }, configurable: true });
  if (mode === 6) { (Parent as any).marker = 7; (Parent.prototype as any).marker = 9; }
  if (mode === 7) { (Parent as any).constructor = Child; (Parent.prototype as any).constructor = 7; }
  const input = new Parent();
  const protoConstructor = (input as any).constructor;
  const staticConstructor = (Parent as any).constructor;
  const name = (value: any) => value === Parent ? 'Parent' : value === Child ? 'Child' : value === Object ? 'Object' : String(value);
  console.log(mode, 0, name(protoConstructor));
  console.log(mode, 1, name(staticConstructor));
  console.log(mode, 2, String((Parent as any).marker), String((input as any).marker));
  const descriptor = Object.getOwnPropertyDescriptor(Parent.prototype, 'constructor');
  console.log(mode, 3, descriptor === undefined ? 'absent' : descriptor.get ? 'getter' : 'data', input.read());
}
