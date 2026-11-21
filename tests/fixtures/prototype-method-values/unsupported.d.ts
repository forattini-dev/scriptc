export class Parent { read(): string; }
export class SuperChild extends Parent { read(): string; }
export class PrivateBox { read(): string; }
export class RestBox { read(...values: string[]): string; }
export class AsyncBox { read(): Promise<string>; fail(): Promise<string>; }
