function failure(started) {
  return started ? "resident rsp server did not start" : new Error("spawn failed");
}

const message = "resident rsp server did not start";
console.log(message instanceof Error ? "error" : "message");

const error = failure(process.argv.length > 0);
console.log(error instanceof Error ? error.message : error);
