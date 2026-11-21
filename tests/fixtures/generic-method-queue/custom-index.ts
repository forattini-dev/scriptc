interface Entry<T> { value: T }
class Observer {
  private custom = { indexOf: (entry: Entry<any>) => Number(entry.value) };
  observe<T>(entry: Entry<T>): void { console.log(this.custom.indexOf(entry)); }
}
new Observer().observe({ value: 3 });
