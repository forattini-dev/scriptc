async function main() {
  const stream = new ReadableStream<Uint8Array>({
    type: "bytes",
    start(controller) {
      controller.enqueue(new Uint8Array([65, 66]));
      controller.close();
    },
  });
  const result = await stream.getReader().read();
  console.log(result.value?.[0], result.value?.[1], result.done);
}

void main();
