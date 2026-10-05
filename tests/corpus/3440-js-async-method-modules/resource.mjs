export class Resource {
  closed = false;
  calls = 0;

  async destroy() {
    this.calls++;
    await Promise.resolve();
    this.closed = true;
  }

  async unused() {
    eval("unused imported async bodies must not be lowered");
  }
}
