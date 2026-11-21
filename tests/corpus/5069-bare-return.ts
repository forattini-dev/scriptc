function stop(ready: boolean): void {
  if (ready) return;
  console.log("continued");
  return;
}

stop(true);
stop(false);
