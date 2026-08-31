let UnknownFlagError;

const once = (factory, value) => () =>
  (factory && (value = factory(factory = 0)), value);

const initialize = once(() => {
  UnknownFlagError = class extends Error {
    flag;
    known;

    constructor(flag, known) {
      super(`unknown flag '${flag}'; expected one of: ${known.join(", ")}`);
      this.name = "UnknownFlagError";
      this.flag = flag;
      this.known = known;
    }
  };
});

initialize();
const error = new UnknownFlagError("--wat", ["--help", "--version"]);

console.log(error instanceof Error, error.name);
console.log(error.message);
console.log(error.flag, error.known.join("|"));
