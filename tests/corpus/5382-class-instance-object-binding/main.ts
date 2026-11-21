class Options {
  value = 'native';
  missing?: string;
}

function inspect(source: Options | { value: string; missing?: string }): void {
  const { value, missing = 'fallback' } = source;
  console.log(value, missing);
}

inspect(new Options());
inspect({ value: 'record' });
