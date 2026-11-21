class Agent {
  close() {
    return Promise.resolve('closed')
  }
}

/** @returns {Promise<any>} */
function closeAll() {
  const agent = new Agent()
  return Promise.all([
    agent.close(),
    false && agent.close()
  ])
}

async function main() {
  console.log(JSON.stringify(await closeAll()))
}

main()
