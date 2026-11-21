type Options = { input: string | string[] };
function run(options: Options) {
  const isBatch = Array.isArray(options.input);
  const inputs = isBatch ? options.input : [options.input];
  const output = (inputs as any).map((text: string) => ({ text }));
  console.log(JSON.stringify(output));
}
run({ input: ['one', 'two'] });
run({ input: 'one' });
