// The stream-surface validation ladders: finished() over a provably-non-
// stream value answers Node's isNodeStream ERR_INVALID_ARG_TYPE (the
// watcher never registers), socket write's two-argument encoding form
// implements Node's stream_base typecheck — write(string, 'buffer') is
// the synchronous "Second argument must be a buffer" TypeError on an
// established socket, an encoding Node does not know at all is its
// ERR_UNKNOWN_ENCODING, utf8 spellings are the plain write — and
// Readable.toWeb's `type` option answers Node's one-of ladder before any
// web-stream machinery.
'use strict';
const net = require('net');
const { Duplex, Readable, finished } = require('stream');
const show = (fn) => { try { fn(); console.log('ok'); } catch (e) { console.log(`${e.name}|${e.code}|${e.message}`); } };

show(() => { finished({}, () => {}); });
show(() => { finished('nope', () => {}); });

const nodeStream = new Readable({ read() {} });
show(() => { Readable.toWeb(nodeStream, { type: 'wrong type' }); });
nodeStream.destroy();

const streamObj = new Duplex();
streamObj.end();
finished(streamObj, () => console.log('finished fired'));

// Deterministic teardown: destroy the ACCEPTED socket too — relying on
// the peer's destroy to close the server side races the event loop (the
// server keeps the loop alive until its connection count drains, which
// under a slow environment can outlive the run).
const server = net.createServer((sock) => sock.destroy()).listen(0, () => {
  const client = net.connect(server.address().port, () => {
    show(() => { client.write('broken', 'buffer'); });
    show(() => { client.write('broken', 'bogus-encoding'); });
    client.write('fine', 'utf8');
    client.destroy();
    server.close();
  });
});
