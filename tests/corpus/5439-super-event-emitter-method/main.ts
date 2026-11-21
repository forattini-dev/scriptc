import { EventEmitter } from 'node:events';

class DerivedEmitter extends EventEmitter {
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

const emitter = new DerivedEmitter();
let value = '';
emitter.on('value', (next) => {
  value = String(next);
});
console.log(emitter.emit('value', 'ok'), value);
