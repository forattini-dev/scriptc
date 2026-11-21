class RpcClient {
  call(method) {
    return method + ':done';
  }
}

class CacheClient {
  /** @param {{ call: Function }} client */
  constructor(client) {
    this.client = client;
  }

  run() {
    return this.client.call('cache');
  }
}

console.log(new CacheClient(new RpcClient()).run());
