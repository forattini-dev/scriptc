import { pipeline, Transform } from "node:stream";

class Collector extends Transform {
  values: string[] = [];

  _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.values.push(`${encoding}:${chunk.toString("utf8")}`);
    callback();
  }
}

class Rejecting extends Transform {
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(new Error(`rejected:${chunk.toString("utf8")}`));
  }
}

const source = new ReadableStream<Uint8Array>({
  start(controller): void {
    controller.enqueue(Buffer.from("alpha"));
    controller.enqueue(Buffer.from("beta"));
    controller.close();
  },
});
const destination = new Collector();
const returned = pipeline(source, destination, (error): void => {
  console.log(error == null ? "complete" : `error:${error.message}`);
  console.log(destination.values.join("|"));

  const failureSource = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(Buffer.from("stop"));
      controller.close();
    },
  });
  const rejecting = new Rejecting();
  const rejected = pipeline(failureSource, rejecting, (failure): void => {
    console.log(failure == null ? "unexpected-success" : `error:${failure.message}`);
  });
  console.log(rejected === rejecting);
});

console.log(returned === destination);
