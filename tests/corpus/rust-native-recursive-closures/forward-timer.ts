function runForwardTimer(): void {
  const finish = (): void => {
    clearTimeout(timer);
    console.log("forward timer");
  };
  const timer = setTimeout(() => console.log("unexpected timer"), 1_000);
  finish();
}

runForwardTimer();
