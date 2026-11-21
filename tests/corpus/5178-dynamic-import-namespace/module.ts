export function first(): string {
  return "native";
}

export function second(value: string): string {
  return `${value}:rust`;
}
