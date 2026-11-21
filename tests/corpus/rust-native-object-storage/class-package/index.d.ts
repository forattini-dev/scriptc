export interface Client {
  read(): string;
  set(value: string): void;
}

export interface ClientConstructor {
  new(value: string): Client;
}

export const Base: ClientConstructor;
