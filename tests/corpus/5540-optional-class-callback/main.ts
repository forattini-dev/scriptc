export {};
class Cache {
  onEvict?: ((this: Cache, key: string) => void) | null;
  count = 0;
  touches = 0;
  seen = new Map<string, number>();
  install(callback?: ((this: Cache, key: string) => void) | null): void { this.onEvict = callback; }
  evict(key: string): void { this.onEvict?.(key); }
  computed(): void { this.onEvict?.(this.replace()); }
  replace(): string {
    this.touches++;
    this.install(function (this: Cache, key: string): void { console.log('replacement', this === cache, key); });
    return 'computed';
  }
}
const cache = new Cache();
cache.evict('absent');
cache.install(function (this: Cache, key: string): void { this.count++; this.seen.set(key, this.count); console.log('callback', this === cache, key, this.count); });
cache.evict('first');
cache.evict('second');
cache.computed();
cache.evict('next');
cache.install(undefined);
cache.evict('absent again');
cache.computed();
cache.install(null);
cache.evict('null');
cache.computed();
console.log('count', cache.count, 'touches', cache.touches, 'seen', cache.seen.get('computed'));
cache.install(function (): void { throw new Error('callback failed'); });
try { cache.evict('throw'); } catch (error) { console.log('caught', (error as Error).message); }
