let Cached;

const NativeCache = class NativeCache {
  install() {
    if (!Cached) {
      Cached = value => `native:${value}`;
    }
    return Cached('ok');
  }
};

console.log(new NativeCache().install());
