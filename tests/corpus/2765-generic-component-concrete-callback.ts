interface Props {
  readonly text: string;
}

interface Row {
  readonly text: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproduces the open component callback surface
function component<TComponent extends (props: any, ...args: any[]) => any>(render: TComponent): TComponent;
function component<P extends object, TResult>(render: (props: P) => TResult): (props: P) => TResult;
function component<P extends object, TResult>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproduces the open implementation signature
  render: (props: P, ...args: any[]) => TResult,
): (props: P) => TResult {
  return (props: P): TResult => render(props);
}

const Concrete = component((props: Props): Row => ({ text: props.text }));
console.log(Concrete({ text: "ok" }).text);
