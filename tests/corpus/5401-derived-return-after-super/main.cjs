class Base {
  constructor(message) {
    this.message = message;
  }
}

class Child extends Base {
  constructor(fast) {
    super('base');
    if (fast) {
      return;
    }
    this.state = 'ready';
  }
}

for (const fast of [true, false]) {
  const value = new Child(fast);
  console.log(value.message, value.state, value instanceof Child);
}
