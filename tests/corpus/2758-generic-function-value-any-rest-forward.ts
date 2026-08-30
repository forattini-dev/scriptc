// @dynamic

function invoke<P extends object, TResult>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the dynamic rest boundary is the behavior under test
  render: (props: P, ...args: any[]) => TResult,
  props: P,
  ...args: unknown[]
): TResult {
  return render(props, ...args);
}

const result = invoke(
  (props: { label: string }, suffix: string) => `${props.label}${suffix}`,
  { label: "native" },
  "!",
);

console.log(result);
