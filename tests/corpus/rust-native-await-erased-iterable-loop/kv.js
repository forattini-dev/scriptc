export class KvClient {
  async list(options) {
    console.log("list", options.limit);
    return JSON.parse('{"items":[{"key":"blob:a","value":1},{"key":"meta:b","value":2},{"key":"blob:c","value":3}]}');
  }
  async delete(key) {
    await Promise.resolve();
    console.log("delete", key);
  }
}
export function connect() {
  return new KvClient();
}
