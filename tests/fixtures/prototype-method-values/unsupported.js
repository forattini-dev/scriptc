export class Parent { read() { return 'parent'; } }
export class SuperChild extends Parent { read() { return super.read() + ':child'; } }
export class PrivateBox { #value = 'secret'; read() { return this.#value; } }
export class RestBox { read(...values) { return values.join(','); } }
export class AsyncBox {
  async read() { await Promise.resolve('tick'); return this.value; }
  async fail() { throw new TypeError('failed'); }
}
