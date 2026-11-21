class Client {
  constructor(value) {
    this.value = value
  }

  close() {
    return Promise.resolve(this.value)
  }
}

class Pool {
  clients = [new Client(2), new Client(3)]

  close() {
    const closeAll = []
    for (const client of this.clients) {
      closeAll.push(client.close())
    }
    return Promise.all(closeAll)
  }
}

async function main() {
  console.log((await new Pool().close()).join(','))
}

main()
