const controller = new AbortController();

controller.signal.addEventListener("abort", (event) => {
  console.log(event.target === controller.signal);
});

controller.abort();
