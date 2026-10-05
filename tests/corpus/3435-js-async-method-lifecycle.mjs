class Handler {
  closed = false;

  async destroyAsync() {
    console.log("handler:start");
    await Promise.resolve();
    this.closed = true;
    console.log("handler:closed");
  }
}

class Resource {
  handler = new Handler();
  destroyed = false;

  stopPool() {
    console.log("stop-pool");
  }

  removeAllListeners() {
    console.log("listeners");
  }

  async destroy() {
    await this.handler.destroyAsync();
    this.destroyed = this.handler.closed;
    this.stopPool();
    this.removeAllListeners();
  }
}

const client = new Resource();
const other = new Resource();
const pending = client.destroy();
console.log("after-call", client.destroyed, other.destroyed);
await pending;
console.log("after-await", client.destroyed, other.destroyed);
