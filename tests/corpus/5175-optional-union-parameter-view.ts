function join(value: string, suffix?: string): string {
  return `${value}:${suffix ?? "none"}`;
}

const required: (value: string, suffix: string) => string = join;
console.log(required("native", "rust"));
