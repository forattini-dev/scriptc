export interface NamedValue {
  value: string;
}

export function describe(input: NamedValue): string {
  return `wssource:${input.value}:${input.value.length}`;
}
