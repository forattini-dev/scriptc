export {};
class Cache {
  reads = 0;
  get onEvict(): ((key: string) => void) | undefined {
    this.reads++;
    console.log('getter', this.reads);
    return function (this: Cache, key: string): void { console.log('callback', this.reads, key); };
  }
  evict(): void { this.onEvict?.('entry'); }
}
new Cache().evict();
