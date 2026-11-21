const kFastTimer = Symbol('kFastTimer');

class FastTimer {
  [kFastTimer] = true;

  valid() {
    return this[kFastTimer];
  }
}

const timer = new FastTimer();
console.log(timer[kFastTimer], timer.valid());
