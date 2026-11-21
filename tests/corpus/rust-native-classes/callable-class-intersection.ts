class KvClient {
  put(value: string): string {
    return `put:${value}`;
  }

  get(): string {
    return 'get';
  }
}

const defaultKv = new KvClient();
const kv: KvClient & ((collection?: string) => KvClient) = Object.assign(
  (_collection = 'kv_default') => new KvClient(),
  {
    put: defaultKv.put.bind(defaultKv),
    get: defaultKv.get.bind(defaultKv),
  },
);

console.log(kv('next').put('a'), kv.put('b'), kv.get());
