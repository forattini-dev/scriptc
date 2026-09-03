const controller = new AbortController();
controller.abort("stop now");

try {
  controller.signal.throwIfAborted();
} catch (reason) {
  console.log(reason);
}
