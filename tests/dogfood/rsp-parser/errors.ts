import {
  ParseError, MissingRequiredError, MissingPositionalError, UnknownOptionError,
  InvalidValueError, TypeCoercionError, UnknownCommandError,
} from "cli-args-parser";

const errors = [
  new ParseError("base", "BASE", { value: 7 }),
  new MissingRequiredError("output"),
  new MissingPositionalError("file"),
  new UnknownOptionError("wat"),
  new InvalidValueError("format", "xml", ["json", "toon"]),
  new TypeCoercionError("oops", "number"),
  new UnknownCommandError("wat", ["build", "run"]),
];
for (const error of errors) {
  console.log(error.name, error.message, error.code, JSON.stringify(error.details),
    error instanceof Error, error instanceof ParseError);
}
