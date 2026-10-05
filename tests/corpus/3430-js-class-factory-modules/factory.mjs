export const events = [];
export class Base {
  constructor(value) { this.value = value; events.push("base"); }
  describe() { return `base:${this.value}`; }
}
export function configured(config) {
  return class extends Base {
    describe() { return `${config.label}:${super.describe()}`; }
    static label() { return config.label; }
  };
}
