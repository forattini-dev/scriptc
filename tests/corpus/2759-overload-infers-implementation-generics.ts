// @dynamic

interface KeyProps {
  readonly key?: string;
}

interface Props {
  label: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors an open component callback surface
function component<TComponent extends (props: any, ...args: any[]) => any>(render: TComponent): TComponent;
function component<P extends object, TResult>(render: (props: P) => TResult): (props: P) => TResult;
function component<P extends object, TResult>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors an open component callback surface
  render: (props: P, ...args: any[]) => TResult,
): (props: P) => TResult {
  const owned = (input: P & KeyProps): TResult => {
    const { key, ...props } = input;
    if (key !== undefined) console.log(`key:${key}`);
    return render(props as P);
  };
  return owned;
}

const Native = component((props: Props) => props.label);
console.log(Native({ label: "native" }));
