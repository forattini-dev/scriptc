/** @type {{ push?: (chunk: any, encoding?: BufferEncoding | undefined) => boolean }} */
const options = {
  push: (event) => {
    console.log(event.type)
  }
}

options.push?.({ type: 'message' })
console.log(true)
