declare class Limiter {
  on(name: string, callback: (value: string) => string): string;
}

export = Limiter;
