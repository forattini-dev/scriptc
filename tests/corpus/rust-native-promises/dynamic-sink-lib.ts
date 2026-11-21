let sink: ((line: string) => void) | null = null;
export function subscribe(next: (line: string) => void): () => void {
  const previous = sink;
  sink = next;
  return () => { sink = previous; };
}
export function send(line: string): void {
  if (sink) sink(line);
}
