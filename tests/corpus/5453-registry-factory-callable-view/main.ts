class IterableOwner {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }

  [Symbol.iterator](): Iterator<number> {
    return [this.value][Symbol.iterator]();
  }
}

interface ConcreteOptions {
  apiKey: string;
}

interface ClientOptions {
  baseUrl: string;
  owner: IterableOwner | null;
}

interface ConcreteClientOptions extends ClientOptions {
  apiKey: string;
}

type Factory = (options: any) => ClientOptions;

function concrete(options: ConcreteOptions): ConcreteClientOptions {
  return {
    baseUrl: "https://example.test",
    owner: new IterableOwner(7),
    apiKey: options.apiKey,
  };
}

const registry: Array<{ name: string; factory: Factory }> = [
  { name: "concrete", factory: concrete },
];

const result = registry[0].factory({ apiKey: "secret" });
console.log(registry[0].name, result.baseUrl, result.owner?.value);
