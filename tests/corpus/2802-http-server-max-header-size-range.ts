import * as http from "node:http";

// maxHeaderSize validates before a server is returned. Negative values use
// Node's catchable RangeError and ERR_OUT_OF_RANGE contract.
try {
  http.createServer({ maxHeaderSize: -1 });
  console.log("unexpected");
} catch (error) {
  if (error instanceof Error) {
    console.log(error.name, (error as NodeJS.ErrnoException).code, error.message);
  }
}
