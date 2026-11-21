class Parent {
  static identifiesParent(): boolean { return this === Parent; }
  static identifiesChild(): boolean { return this === Child; }
}
class Child extends Parent {}
console.log("parent", Parent.identifiesParent(), Parent.identifiesChild());
console.log("child", Child.identifiesParent(), Child.identifiesChild());
class Standalone { static check(): boolean { return this === this; } }
console.log("standalone", Standalone.check());
