// A PassThrough subclass initializes the same composed Transform state while
// retaining passthrough behavior and its derived-class identity.
import { PassThrough } from "node:stream";

class Relay extends PassThrough {
  label = "relay";
}

const relay = new Relay();
const chunks: string[] = [];
relay.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
relay.on("end", () => console.log(relay.label, relay instanceof Relay, chunks.join("+")));
relay.write("one");
relay.end("two");
