const controller = new AbortController();

controller.signal.addEventListener("abort", (event) => {
  console.log(event.type);
});

controller.abort();
