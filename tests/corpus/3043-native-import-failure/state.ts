export const failure = new Error("module failure");
export let attempts = 0;

export function recordAttempt(): void {
  attempts++;
}
