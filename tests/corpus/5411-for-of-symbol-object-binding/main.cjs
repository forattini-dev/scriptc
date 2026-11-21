const kConnected = Symbol('connected')

class Client {
  constructor(connected) {
    this[kConnected] = connected
  }
}

class Pool {
  clients = [new Client(2), new Client(3)]

  get connected() {
    let total = 0
    for (const { [kConnected]: connected } of this.clients) {
      total += connected
    }
    for (const { bonus } of [{ bonus: 4 }]) {
      total += bonus
    }
    return total
  }
}

console.log(new Pool().connected)
