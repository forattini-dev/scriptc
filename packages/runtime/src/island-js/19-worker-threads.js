    /* node:worker_threads — the MAIN-THREAD surface, loadable because
     * undici (proxy-agent's dispatcher, in a real CLI's graph when
     * proxy env vars exist) requires it UNGUARDED at load: fetch/
     * constants.js destructures MessageChannel/receiveMessageOnPort for
     * its structuredClone fallback, websocket/events.js MessagePort.
     * Ports are a REAL in-process pair (postMessage queues on the peer,
     * receiveMessageOnPort drains) with one documented divergence:
     * messages pass by REFERENCE, not structured clone — the island has
     * no serializer, and the only in-graph consumer clones-and-reads
     * immediately. Worker itself fences loudly at construction: there is
     * no worker runtime. */
  builtins.worker_threads = memo(() => {
    /* The pair IS the web prelude's global classes (Node exposes the
     * same identities as globals and module members), so instanceof
     * agrees across both spellings; postMessage delivers
     * structuredClone copies through the prelude's serializer. */
    const MessagePort = globalThis.MessagePort;
    const MessageChannel = globalThis.MessageChannel;
    const receiveMessageOnPort = (port) => (port._queue.length > 0 ? port._queue.shift() : undefined);
    class Worker {
      constructor() { throw new Error("node:worker_threads 'Worker' is not supported in the scriptc island (the embedded engine has no worker runtime)"); }
    }
    const wt = {
      isMainThread: true, parentPort: null, threadId: 0, workerData: null, resourceLimits: {},
      MessageChannel, MessagePort, Worker, receiveMessageOnPort,
      markAsUntransferable: () => {}, isMarkedAsUntransferable: () => false,
      getEnvironmentData: () => undefined, setEnvironmentData: () => {},
      SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'),
    };
    wt.default = wt;
    return wt;
  });
