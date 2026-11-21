export async function checkbox<T extends string>(
  message: string,
  choices: readonly T[],
  fallback: T[] = [],
): Promise<T[]> {
  if (message.length > 100) return fallback;
  return choices.filter((choice) => choice.length > 0);
}
