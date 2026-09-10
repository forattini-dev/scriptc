// @no-engine
'use strict';
const dgram = require('node:dgram');
const { finished, pipeline, PassThrough } = require('node:stream');

function show(fn) {
  try { fn(); console.log('unexpected success'); }
  catch (error) { console.log(error.name + '|' + error.code + '|' + error.message); }
}
function mark() { console.log('evaluate marker'); return 1; }

show(() => { dgram.createSocket({ type: 'udp4', signal: {} }); });
show(() => { dgram.createSocket({ type: 'udp4', signal: { marker: mark() } }); });
show(() => { dgram.createSocket({ type: 'udp4', signal: { enabled: false, nested: { value: 1 } } }); });
show(() => { dgram.createSocket({ type: 'udp4', signal: 'invalid' }); });
show(() => { dgram.createSocket({ type: 'udp4', signal: 42 }); });
show(() => { dgram.createSocket({ type: 'udp4', signal: false }); });
show(() => { dgram.createSocket({ type: 'udp4', signal: [] }); });

show(() => { finished({}, () => {}); });
show(() => { finished({ marker: mark() }, () => {}); });
show(() => { finished({ enabled: false, nested: { value: 1 } }, () => {}); });
show(() => { finished([], () => {}); });
show(() => { finished([mark()], () => {}); });
show(() => { finished('invalid', () => {}); });

const destination = new PassThrough();
show(() => { pipeline({}, destination, () => {}); });
show(() => { pipeline({ marker: mark() }, destination, () => {}); });
