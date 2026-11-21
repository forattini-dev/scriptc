type OptionValue = string | number | boolean | null;
type Options = Record<string, OptionValue>;
type Parsed = {
  options: Options;
  errors: string[];
  [key: string]: string[] | Options;
};

function makeSource() {
  const options = {};
  (options as any).mode = "fast";
  return { options, errors: [] as string[] };
}

const parsed: Parsed = makeSource();
console.log(parsed.options.mode);
parsed.options.mode = "safe";
console.log(parsed.options.mode);
