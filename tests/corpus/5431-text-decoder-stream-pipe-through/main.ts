async function main(): Promise<void> {
  const source = new Response(new Uint8Array([65, 240, 159, 152, 128, 66]).buffer).body!
  // @ts-ignore lib.dom models BufferSource more broadly than this byte stream.
  const decoded = source.pipeThrough(new TextDecoderStream())
  console.log(source.locked, decoded.locked)
  const reader = decoded.getReader()
  const first = await reader.read()
  const done = await reader.read()
  console.log(first.value, done.done)
  reader.releaseLock()

  const manual = new ReadableStream<Uint8Array>({
    async start(controller) {
      console.log("start", controller.desiredSize)
      await Promise.resolve()
      controller.enqueue(new Uint8Array([7, 8]))
      controller.close()
    },
  })
  const manualReader = manual.getReader()
  const chunk = await manualReader.read()
  console.log(chunk.value!.join(","), (await manualReader.read()).done)
  manualReader.releaseLock()
}

void main()
