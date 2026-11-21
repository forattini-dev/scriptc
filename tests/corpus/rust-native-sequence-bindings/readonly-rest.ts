function route<C extends string>(argv: readonly string[], _command: C): void {
  const [first, ...rest] = argv;
  console.log(first, rest.join(","));
}

route(["a", "b", "c"], "go");

function unionRest(argv: readonly string[] | readonly number[]): void {
  const [first, ...rest] = argv;
  console.log(first, rest.join(","));
}

const names = ["x", "y", "z"];
const numbers = [1, 2, 3];
unionRest(names);
unionRest(numbers);

function maybeRest(argv: string[] | undefined): void {
  // @ts-expect-error This fixture checks the JavaScript iterable error path.
  const [first, ...rest] = argv;
  console.log(first, rest.join(","));
}

maybeRest(["p", "q"]);
try {
  maybeRest(undefined);
} catch (error) {
  console.log((error as Error).message);
}
