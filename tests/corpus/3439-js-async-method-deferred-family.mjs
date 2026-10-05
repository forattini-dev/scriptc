class Base {
  label = "base";

  async value() {
    eval("unused virtual async bodies must not be lowered");
    return this.label;
  }

  good() {
    return this.label;
  }
}

class Child extends Base {
  label = "child";

  async value() {
    return this.label;
  }
}

class Seed {}
class Unrelated extends Seed {
  async value() {
    return "unrelated";
  }
}

class SyncBase {
  value() {
    return Promise.resolve("exact-base");
  }
}

class AsyncChild extends SyncBase {
  async value() {
    return "deferred-child";
  }
}

console.log(new Base().good(), new Child().good());
console.log(await new Unrelated().value());
new AsyncChild();
console.log(await new SyncBase().value());
