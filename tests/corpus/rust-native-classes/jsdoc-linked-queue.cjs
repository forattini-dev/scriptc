'use strict';

const size = 4;
const mask = size - 1;

/** @template T */
class Buffer {
  bottom = 0;
  top = 0;
  /** @type {Array<T|undefined>} */
  list = new Array(size).fill(undefined);
  /** @type {Buffer<T>|null} */
  next = null;

  isEmpty() { return this.bottom === this.top; }
  isFull() { return ((this.top + 1) & mask) === this.bottom; }
  /** @param {T} data */
  push(data) {
    this.list[this.top] = data;
    this.top = (this.top + 1) & mask;
  }
  /** @returns {T|null} */
  shift() {
    const value = this.list[this.bottom];
    if (value === undefined) return null;
    this.list[this.bottom] = undefined;
    this.bottom = (this.bottom + 1) & mask;
    return value;
  }
}

/** @template T */
class Queue {
  constructor() {
    /** @type {Buffer<T>} */
    this.head = this.tail = new Buffer();
  }
  /** @param {T} data */
  push(data) {
    if (this.head.isFull()) this.head = this.head.next = new Buffer();
    this.head.push(data);
  }
  /** @returns {T|null} */
  shift() {
    const tail = this.tail;
    const value = tail.shift();
    if (tail.isEmpty() && tail.next !== null) {
      this.tail = tail.next;
      tail.next = null;
    }
    return value;
  }
}

const queue = new Queue();
for (const value of [1, 2, 3, 4]) queue.push(value);
console.log(queue.shift(), queue.shift(), queue.shift(), queue.shift(), queue.shift());
