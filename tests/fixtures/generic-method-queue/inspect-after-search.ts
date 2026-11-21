interface Entry<T> { value: T }
class Reader {
  private entries: Array<Entry<any>> = [];
  read<T>(entry: Entry<T>): void {
    this.entries.indexOf(entry);
    console.log(entry.value);
  }
}
new Reader().read({ value: 3 });
