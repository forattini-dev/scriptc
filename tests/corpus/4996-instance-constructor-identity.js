// @ts-nocheck
class Identity {
  static label = "native";
  /** @type {Array<(value: number) => number>} */
  static plugins = [(value) => value + 1];

  /** @returns {string} */
  read() {
    const constructor = this.constructor;
    return `${constructor.label}|${constructor.plugins[0](41)}`;
  }
}

console.log(new Identity().read());
