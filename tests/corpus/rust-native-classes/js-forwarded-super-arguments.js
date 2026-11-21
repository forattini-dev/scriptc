class Base {
  constructor(config) {
    this.value = config.value;
  }
}

class Middle extends Base {
  constructor() {
    super(...arguments);
    this.middle = true;
  }
}

class Derived extends Middle {
  constructor() {
    super(...arguments);
    this.derived = true;
  }
}

const result = new Derived({ value: 42 });
console.log(result.value, result.middle, result.derived);
