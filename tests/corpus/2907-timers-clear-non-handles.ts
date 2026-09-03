console.log("before");

clearTimeout(null as never);
clearInterval({} as never);
clearImmediate(undefined);

console.log("after");
