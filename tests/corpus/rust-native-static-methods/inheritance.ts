export {};
class Base {
  static label(): string { return 'base'; }
  label(): string { return 'instance'; }
}
class Child extends Base {}
class Override extends Base { static label(): string { return 'child'; } }
console.log('static', Base.label(), Child.label(), Override.label());
console.log('instance', new Base().label(), new Child().label());
