export class Payload {
  count = 5;
  [Symbol.iterator](offset: number): number { return this.count + offset; }
}
