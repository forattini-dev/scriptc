const { Transform } = require('node:stream');

const effects = [];

class EventSourceStream extends Transform {
  constructor(options = {}) {
    options.readableObjectMode = true;
    super(options);
    this.state = options.eventSourceSettings || {};
    if (options.push) this.push = options.push;
    effects.push(options.readableObjectMode, this.state.name);
  }
}

const stream = new EventSourceStream({ eventSourceSettings: { name: 'ready' } });
console.log(effects.join(','), stream instanceof Transform, stream.state.name);
