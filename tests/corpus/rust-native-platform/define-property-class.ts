function renamedClass(): string {
  class Original {}

  Object.defineProperty(Original, "name", {
    value: "Renamed",
    configurable: true,
  });

  return "defined";
}

console.log(renamedClass());
