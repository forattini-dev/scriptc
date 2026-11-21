function make(prefix: string) {
  return class {
    async read() {
      await Promise.resolve();
      return prefix;
    }
  };
}
const Item = make("ready");
new Item().read().then((value: string) => console.log(value));
