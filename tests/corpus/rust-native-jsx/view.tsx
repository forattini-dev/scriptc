function Label(props: { value: string }): string {
  return props.value.toUpperCase();
}

export const rendered = <Label value="native" />;
export const intrinsic = <box>child</box>;
