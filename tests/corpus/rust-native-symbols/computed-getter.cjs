const pending = Symbol('pending');

class Queue {
  constructor() {
    this.size = 3;
  }

  get [pending]() {
    return this.size + 1;
  }
}

const queue = new Queue();
console.log(queue[pending], queue[pending]);
