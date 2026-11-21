async function* source() {
  try {
    yield 1
    yield 2
  } finally {
    console.log('closed')
  }
}

async function run() {
  for await (const value of source()) {
    console.log(value)
    break
  }
  console.log('done')
}

run()
