const order = [];

class Base {
  constructor() {
    order.push('base');
  }
}

class Derived extends Base {
  constructor() {
    super(order.push('argument'));
    order.push('derived');
  }
}

new Derived();
console.log(order.join(','));
