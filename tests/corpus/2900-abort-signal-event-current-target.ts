const controller = new AbortController();

controller.signal.addEventListener("abort", (event) => {
  console.log(event.currentTarget === controller.signal);
});

controller.abort();
