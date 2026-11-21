// @rust-only
// @no-engine
function run(): void {
  let ticks = 0;
  const watchdog = setInterval(() => {
    ticks += 1;
    console.log("watchdog", ticks);
    clearInterval(watchdog);
  }, 1);
}

run();
