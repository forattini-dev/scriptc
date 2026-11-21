interface Options {
  label: string;
  fetchImpl?: OpenCallable;
}
interface OpenCallable {
  (input: string): Promise<string>;
  (input: number): Promise<number>;
}

function inspect(options: Options): void {
  console.log(options.label);
  console.log(options.fetchImpl === undefined);
}

inspect({ label: "ok" });
