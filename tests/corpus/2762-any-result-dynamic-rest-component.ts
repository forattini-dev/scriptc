// @dynamic

interface KeyProps {
  readonly key?: string;
}

interface StatefulComponent<P extends object, TResult> {
  (props: P & KeyProps): TResult;
  readonly displayName: string;
}

interface StatefulComponentWithoutProps<TResult> {
  (props?: KeyProps): TResult;
  readonly displayName: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproduces the open component callback surface
type OwnedComponent<TComponent extends (props: any, ...args: any[]) => any> = TComponent & {
  readonly displayName: string;
};

function component<TResult = string>(name: string, render: () => TResult): StatefulComponentWithoutProps<TResult>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproduces the open component callback surface
function component<TComponent extends (props: any, ...args: any[]) => any>(
  name: string,
  render: TComponent,
): OwnedComponent<TComponent>;
function component<P extends object, TResult = string>(
  name: string,
  render: (props: P) => TResult,
): StatefulComponent<P, TResult>;
function component<P extends object, TResult = string>(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproduces the open component callback surface
  render: (props: P, ...args: any[]) => TResult,
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproduces the open component callback surface
): StatefulComponent<P, TResult> | StatefulComponentWithoutProps<TResult> | OwnedComponent<any> {
  const owned = (input: P & KeyProps = {} as P & KeyProps, ...args: unknown[]): TResult => {
    const { key, ...props } = input;
    if (key !== undefined) console.log(`${name}:${key}`);
    return render(props as P, ...args);
  };
  Object.defineProperty(owned, "displayName", {
    value: name,
    enumerable: true,
  });
  return owned as StatefulComponent<P, TResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pins the TResult=any instantiation from real component factories
const result: any = "dynamic";
const Dynamic = component("Dynamic", () => result);
console.log(Dynamic.displayName);
console.log(`${Dynamic()}`);
console.log(`${Dynamic({ key: "second" })}`);
