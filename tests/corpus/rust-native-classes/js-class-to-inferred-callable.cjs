class RpcClient {
  call(method, params = {}) {
    return method + ':' + params.name;
  }
}

class QueueClient {
  constructor(client) {
    this.client = client;
  }

  create(name) {
    return this.client.call('create', { name });
  }
}

console.log(new QueueClient(new RpcClient()).create('jobs'));
