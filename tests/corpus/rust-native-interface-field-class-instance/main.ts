interface CacheEntry { template: string; expires: number }
interface TemplateCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}

class LRUCache implements TemplateCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  constructor(maxSize: number) { this.maxSize = maxSize; }
  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }
  set(key: string, entry: CacheEntry): void {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, entry);
  }
  delete(key: string): boolean { return this.cache.delete(key); }
  clear(): void { this.cache.clear(); }
  get size(): number { return this.cache.size; }
}

class TemplateEngine {
  private cache: TemplateCache;
  constructor() {
    this.cache = new LRUCache(2);
  }
  render(name: string): string {
    const hit = this.cache.get(name);
    if (hit) return `hit ${hit.template}`;
    this.cache.set(name, { template: name.toUpperCase(), expires: 0 });
    return `miss (${this.cache.size})`;
  }
}

const engine = new TemplateEngine();
for (const name of ["a", "b", "a", "c", "b"]) console.log(engine.render(name));

interface Assistant {
  readonly model: string;
  ask(question: string): string;
}
class AssistantImpl implements Assistant {
  readonly model: string;
  constructor(model: string) { this.model = model; }
  ask(question: string): string { return `${this.model}: ${question.length}`; }
}
class Client {
  private _ai?: Assistant;
  get ai(): Assistant {
    if (!this._ai) {
      this._ai = new AssistantImpl("gpt");
    }
    return this._ai!;
  }
}
const client = new Client();
console.log(client.ai.ask("hello"), client.ai.model, client.ai === client.ai);
