export class Base {
  run(value) { return value; }
}
export class Child extends Base {
  run(value) { if (value === 'forward') return super.run(value); return value; }
}
