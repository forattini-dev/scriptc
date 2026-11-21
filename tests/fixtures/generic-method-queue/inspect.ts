interface Entry<T> { value: T }
class Reader {
  read<T>(entry: Entry<T>): T { return entry.value; }
}
console.log(new Reader().read({ value: 3 }));
