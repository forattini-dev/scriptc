class Resource {
  attempts = 0;

  async fail() {
    this.attempts++;
    console.log("fail:start");
    await Promise.resolve();
    throw new Error("closed");
  }

  async cleanup() {
    try {
      await this.fail();
    } catch (error) {
      console.log(error.name, error.message);
    } finally {
      this.attempts++;
    }
    return this.attempts;
  }

  async immediate() {
    throw new Error("immediate");
  }
}

const client = new Resource();
const task = client.cleanup();
console.log("after-call", client.attempts);
console.log("done", await task);
const failure = client.immediate();
console.log("promise-created");
try {
  await failure;
} catch (error) {
  console.log(error.name, error.message);
}
