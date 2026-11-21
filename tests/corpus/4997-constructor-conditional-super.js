// @ts-nocheck
class Base {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }

  /** @returns {string} */
  read() {
    return this.value;
  }
}

/**
 * @param {((value: string) => string) | undefined} defaults
 */
function withDefaults(defaults) {
  return class extends Base {
    constructor(value) {
      const options = value || "empty";
      if (typeof defaults === "function") {
        super(defaults(options));
        return;
      }
      super(`${options}!`);
    }
  };
}

const Transformed = withDefaults((value) => value.toUpperCase());
const Plain = withDefaults(undefined);
console.log(`${new Transformed("native").read()}|${new Plain("rust").read()}`);
