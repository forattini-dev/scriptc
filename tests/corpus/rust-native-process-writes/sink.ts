let warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`);
export function setSink(sink: (message: string) => void): (message: string) => void {
  const previous = warn;
  warn = sink;
  return previous;
}
export function warning(message: string): void { warn(message); }
