interface Entry<T> { value: T }
class Queue {
  private entries: any[] = [];
  setup(entry: Entry<any>): void {
    this.entries.push(entry);
    (this.entries as any).indexOf = function (this: any, item: any): number {
      console.log('override', this.length, item.value);
      return -1;
    };
  }
  remove(entry: Entry<any>): void {
    const index = this.entries.indexOf(entry as Entry<unknown>);
    if (index >= 0) this.entries.splice(index, 1);
  }
  count(): number { return this.entries.length; }
}
const entry = { value: 8 };
const queue = new Queue();
queue.setup(entry);
queue.remove(entry);
console.log('remaining', queue.count());
