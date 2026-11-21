/** @returns {Promise<any>} */
function erasedAll() {
  const entries = [Promise.resolve(2), Promise.resolve(3)]
  return Promise.all(entries)
}

async function main() {
  console.log((await erasedAll()).join(','))
}

main()
