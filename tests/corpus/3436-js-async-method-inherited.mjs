class BaseResource {
  label = "base";
  count = 0;

  async #read() {
    const label = this.label;
    await Promise.resolve();
    return label;
  }

  async describe() {
    const label = await this.#read();
    this.count++;
    return `${label}:${this.count}`;
  }

  async unused() {
    eval("unused async bodies must not be lowered");
  }
}

class ChildResource extends BaseResource {
  label = "child";
  extra = true;
}

const first = new ChildResource();
const second = new BaseResource();
const firstPending = first.describe();
const secondPending = second.describe();
console.log("before", first.count, second.count);
console.log(await firstPending, await secondPending);
console.log(await first.describe());
