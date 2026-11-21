function run(): void {
  const abort = new AbortController();
  const signal = abort.signal;
  console.log(signal === abort.signal);
  console.log(abort.signal.aborted);
  abort.abort();
  console.log(abort.signal.aborted);
}

run();
