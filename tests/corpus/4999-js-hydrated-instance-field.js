// @ts-nocheck
function load(source, target) {
  for (const key in source) {
    target[key] = source[key];
  }
}

class Store {
  constructor(options) {
    load(options, this);
    this.ready = this.Promise.resolve("native");
  }
}

new Store({ Promise }).ready.then((value) => {
  const text = /** @type {string} */ (value);
  console.log(text);
});
