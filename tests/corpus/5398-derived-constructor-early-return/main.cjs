class Base {
  constructor(value) {
    this.value = value;
  }
}

class Child extends Base {
  constructor(fast) {
    if (fast) {
      super('fast');
      this.kind = 'fast';
      return;
    }

    const value = 'slow';
    super(value);
    this.kind = value;
  }
}

for (const fast of [true, false]) {
  const child = new Child(fast);
  console.log(child.value, child.kind, child instanceof Base, child instanceof Child);
}
