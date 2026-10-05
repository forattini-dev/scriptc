class Identity {
  calls = 0;

  async value(input) {
    this.calls++;
    await Promise.resolve();
    return input;
  }
}

const client = new Identity();
console.log(await client.value(42));
console.log(await client.value("text"));
console.log(await client.value(true));
console.log(client.calls);
