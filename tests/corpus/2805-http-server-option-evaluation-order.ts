import * as http from "node:http";

function option(label: string, value: number): number {
  console.log(label);
  return value;
}

// Object-literal option values run in source order before createServer returns.
http.createServer({
  maxHeaderSize: option("header", 256),
  keepAliveTimeoutBuffer: option("buffer", 1000),
});
console.log("created");
