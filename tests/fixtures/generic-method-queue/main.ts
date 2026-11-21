interface Entry<T> { value: T }

class Queue {
  private entries: Array<Entry<any>> = [];

  add(entry: Entry<any>): void { this.entries.push(entry); }

  remove<T>(entry: Entry<T>): void {
    const index = this.entries.indexOf(entry as Entry<unknown>);
    if (index >= 0) this.entries.splice(index, 1);
  }

  values(): string { return this.entries.map(entry => String(entry.value)).join(','); }
}

const first = { value: 7 };
const second = { value: 'seven' };
const missing = { value: 7 };
const queue = new Queue();
queue.add(first);
queue.add(second);
queue.add(first);
queue.remove(missing);
console.log('missing', queue.values());
queue.remove(first);
console.log('first', queue.values());
queue.remove(second);
console.log('second', queue.values());
queue.remove(first);
console.log('empty', queue.values());
