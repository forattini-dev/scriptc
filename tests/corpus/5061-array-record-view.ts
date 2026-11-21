type Source = { kind: string; value: string; extra: number };
type Target = { kind: string; value: string };

function render(tokens: Target[]): string {
  return tokens[0].value;
}

const source: Source[] = [{ kind: "word", value: "ok", extra: 1 }];
console.log(render(source));
