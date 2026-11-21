function invoke(callback: () => unknown): unknown {
  return callback();
}

function cleanup(): void {
  console.log("cleanup");
}

console.log(invoke(cleanup) === undefined);
