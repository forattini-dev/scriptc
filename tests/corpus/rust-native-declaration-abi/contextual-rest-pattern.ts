// @rust-only
// @no-engine
interface Options {
  value: number;
}
type Run = (options: Options, label?: string) => Promise<number>;

const service: { run: Run } = {
  run: async (...[options, label]: Parameters<Run>) => {
    return options.value + (label?.length ?? 0);
  },
};

void service.run({ value: 4 }, "ok").then((value) => console.log("result", value));
