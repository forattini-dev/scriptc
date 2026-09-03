import { Readable } from "node:stream";

const received: string[] = [];
const source = new Readable({ read() {} });

source.on("data", (chunk) => received.push(chunk.toString()));
source.on("end", () => console.log(received.join(",")));

function pushDynamic(chunk: any): void {
  source.push(chunk);
}

pushDynamic("alpha");
pushDynamic(Buffer.from("beta"));
pushDynamic(null);
