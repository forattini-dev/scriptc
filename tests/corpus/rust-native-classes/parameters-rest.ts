export {};

class Store {
  async mint(bytes: Uint8Array, meta: { command: string }): Promise<string> {
    return `${bytes.length}:${meta.command}`;
  }
}

class LazyStore {
  private store = new Store();

  async mint(...args: Parameters<Store['mint']>): Promise<string> {
    return await this.store.mint(...args);
  }
}

async function main(): Promise<void> {
  console.log(await new LazyStore().mint(new Uint8Array([1, 2]), { command: 'run' }));
}

void main();
