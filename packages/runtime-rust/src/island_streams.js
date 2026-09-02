(host) => {
  'use strict';
  const g = globalThis;
  class ReadableStream {
    constructor(source, _strategy) {
      if (source === undefined) source = {};
      if (source === null || typeof source !== 'object') {
        throw new TypeError('underlying source must be an object');
      }
      if (source.type !== undefined) {
        throw new RangeError("byte streams (type: 'bytes') are not supported in the scriptc island");
      }
      this._src = source;
      this._queue = [];
      this._state = 'readable';
      this._storedError = undefined;
      this._locked = false;
      this._reads = [];
      this._closeRequested = false;
      this._started = false;
      this._pulling = false;
      this._pullAgain = false;
      this._closedResolve = null;
      this._closedReject = null;
      const self = this;
      this._controller = {
        get desiredSize() {
          if (self._state === 'errored') return null;
          if (self._state === 'closed') return 0;
          return 1 - self._queue.length;
        },
        enqueue(chunk) {
          if (self._closeRequested || self._state !== 'readable') {
            throw new TypeError('cannot enqueue on a stream that is ' + (self._closeRequested ? 'closing' : self._state));
          }
          if (self._reads.length > 0) self._reads.shift().resolve({ value: chunk, done: false });
          else self._queue.push(chunk);
          self._maybePull();
        },
        close() {
          if (self._closeRequested || self._state !== 'readable') {
            throw new TypeError('cannot close a stream that is ' + (self._closeRequested ? 'closing' : self._state));
          }
          self._closeRequested = true;
          if (self._queue.length === 0) self._finishClose();
        },
        error(e) {
          self._errorStream(e);
        },
      };
      let startResult;
      if (source.start) startResult = source.start(this._controller); // a sync throw propagates, per spec
      Promise.resolve(startResult).then(
        () => { this._started = true; this._maybePull(); },
        (e) => this._errorStream(e),
      );
    }
    _finishClose() {
      if (this._state !== 'readable') return;
      this._state = 'closed';
      const reads = this._reads;
      this._reads = [];
      for (const r of reads) r.resolve({ value: undefined, done: true });
      if (this._closedResolve) this._closedResolve();
    }
    _errorStream(e) {
      if (this._state !== 'readable') return;
      this._state = 'errored';
      this._storedError = e;
      this._queue.length = 0;
      const reads = this._reads;
      this._reads = [];
      for (const r of reads) r.reject(e);
      if (this._closedReject) this._closedReject(e);
    }
    /* Proactive pull, like the spec with the default HWM-1 strategy: pull
     * whenever there is space (queue empty), started, and no pull running. */
    _maybePull() {
      const src = this._src;
      if (!src.pull || !this._started) return;
      if (this._state !== 'readable' || this._closeRequested) return;
      if (this._queue.length >= 1) return;
      if (this._pulling) { this._pullAgain = true; return; }
      this._pulling = true;
      Promise.resolve().then(() => {
        if (this._state !== 'readable' || this._closeRequested) { this._pulling = false; return; }
        let r;
        try { r = src.pull(this._controller); } catch (e) { this._pulling = false; this._errorStream(e); return; }
        Promise.resolve(r).then(
          () => {
            this._pulling = false;
            if (this._pullAgain || this._queue.length === 0) { this._pullAgain = false; this._maybePull(); }
          },
          (e) => { this._pulling = false; this._errorStream(e); },
        );
      });
    }
    get locked() { return this._locked; }
    cancel(reason) {
      if (this._locked) return Promise.reject(new TypeError('cannot cancel a locked ReadableStream'));
      return this._cancelInternal(reason);
    }
    _cancelInternal(reason) {
      if (this._state === 'closed') return Promise.resolve();
      if (this._state === 'errored') return Promise.reject(this._storedError);
      this._queue.length = 0;
      this._closeRequested = true;
      this._finishClose();
      const src = this._src;
      return Promise.resolve(src.cancel ? src.cancel(reason) : undefined).then(() => undefined);
    }
    getReader(options) {
      if (options !== undefined && options !== null && options.mode !== undefined) {
        throw new TypeError('BYOB readers are not supported in the scriptc island');
      }
      if (this._locked) throw new TypeError('ReadableStream is locked');
      this._locked = true;
      const self = this;
      let res, rej;
      const closed = new Promise((a, b) => { res = a; rej = b; });
      closed.catch(() => {});
      this._closedResolve = res;
      this._closedReject = rej;
      if (this._state === 'closed') res();
      else if (this._state === 'errored') rej(this._storedError);
      let released = false;
      return {
        get closed() { return closed; },
        read() {
          if (released) return Promise.reject(new TypeError('reader has been released'));
          if (self._queue.length > 0) {
            const chunk = self._queue.shift();
            if (self._closeRequested && self._queue.length === 0) self._finishClose();
            else self._maybePull();
            return Promise.resolve({ value: chunk, done: false });
          }
          if (self._state === 'closed') return Promise.resolve({ value: undefined, done: true });
          if (self._state === 'errored') return Promise.reject(self._storedError);
          return new Promise((resolve, reject) => {
            self._reads.push({ resolve, reject });
            self._maybePull();
          });
        },
        releaseLock() {
          if (released) return;
          released = true;
          const reads = self._reads;
          self._reads = [];
          for (const r of reads) r.reject(new TypeError('reader was released'));
          self._locked = false;
          self._closedResolve = null;
          self._closedReject = null;
        },
        cancel(reason) {
          if (released) return Promise.reject(new TypeError('reader has been released'));
          return self._cancelInternal(reason);
        },
      };
    }
    /* The iterator carries a `finished` latch because the ENGINE's
     * for-await closes more eagerly than V8: quickjs-ng calls return()
     * on NORMAL completion and after a next() rejection (V8 does
     * neither), and an unlatched return() would then cancel a released
     * reader — minting a rejected promise nobody awaits, which the
     * unhandled-rejection tracker reports at exit. Same story for the
     * no-op catch on return()'s result: the engine drops it on those
     * paths, so a real cancel rejection must be pre-observed (callers
     * who DO await it — the break path — still see the rejection). */
    values(options) {
      const preventCancel = options !== undefined && options !== null && !!options.preventCancel;
      const reader = this.getReader();
      let finished = false;
      const it = {
        next() {
          if (finished) return Promise.resolve({ value: undefined, done: true });
          return reader.read().then(
            (r) => {
              if (r.done) { finished = true; reader.releaseLock(); }
              return r;
            },
            (e) => { finished = true; reader.releaseLock(); throw e; },
          );
        },
        return(v) {
          if (finished) return Promise.resolve({ value: v, done: true });
          finished = true;
          const p = preventCancel ? Promise.resolve() : reader.cancel(v);
          reader.releaseLock();
          const res = p.then(() => ({ value: v, done: true }));
          res.catch(() => {});
          return res;
        },
        [Symbol.asyncIterator]() { return this; },
      };
      return it;
    }
    [Symbol.asyncIterator](options) { return this.values(options); }
    static from(iterable) {
      if (iterable === undefined || iterable === null) {
        throw new TypeError('ReadableStream.from requires an iterable');
      }
      const asyncMethod = iterable[Symbol.asyncIterator];
      let method;
      let asyncIterator = false;
      if (asyncMethod !== undefined && asyncMethod !== null) {
        if (typeof asyncMethod !== 'function') {
          throw new TypeError('ReadableStream.from requires an iterable');
        }
        method = asyncMethod;
        asyncIterator = true;
      } else {
        method = iterable[Symbol.iterator];
        if (typeof method !== 'function') {
          throw new TypeError('ReadableStream.from requires an iterable');
        }
      }
      const iterator = method.call(iterable);
      if ((typeof iterator !== 'object' || iterator === null) && typeof iterator !== 'function') {
        throw new TypeError('iterator method must return an object');
      }
      const next = iterator.next;
      let finished = false;
      let started = false;
      return new ReadableStream({
        async pull(controller) {
          started = true;
          const result = asyncIterator ? await next.call(iterator) : next.call(iterator);
          if ((typeof result !== 'object' || result === null) && typeof result !== 'function') {
            throw new TypeError('iterator result is not an object');
          }
          if (result.done) { finished = true; controller.close(); return; }
          controller.enqueue(asyncIterator ? result.value : await result.value);
        },
        async cancel(reason) {
          if (finished) return;
          finished = true;
          if (!started) return;
          const finish = iterator.return;
          if (finish === undefined || finish === null) return;
          if (typeof finish !== 'function') throw new TypeError('iterator return is not a function');
          const result = finish.call(iterator, reason);
          if (!asyncIterator && ((typeof result !== 'object' || result === null) && typeof result !== 'function')) {
            throw new TypeError('iterator result is not an object');
          }
          if (asyncIterator) {
            const awaited = await result;
            if ((typeof awaited !== 'object' || awaited === null) && typeof awaited !== 'function') {
              throw new TypeError('iterator result is not an object');
            }
          }
        },
      });
    }
    pipeThrough(transform, options) {
      if (transform === null || typeof transform !== 'object' || !transform.writable || !transform.readable) {
        throw new TypeError('pipeThrough requires a { writable, readable } pair');
      }
      if (options !== undefined && options !== null && options.signal !== undefined) {
        throw new Error('scriptc: AbortSignal is not supported by island streams yet');
      }
      pump(this, transform.writable);
      return transform.readable;
    }
    pipeTo() {
      throw new Error('ReadableStream.pipeTo is not supported in the scriptc island (use pipeThrough or a reader)');
    }
    tee() {
      throw new Error('ReadableStream.tee is not supported in the scriptc island');
    }
  }

  /* The internal writable half of TransformStream. Deliberately NOT
   * installed as a global WritableStream: the island fences the class
   * (nothing in the supported graph constructs one). */
  class WritableLite {
    constructor(sink) {
      this._sink = sink;
      this._state = 'writable';
      this._err = undefined;
      this._locked = false;
      this._closedRes = null;
      this._closedRej = null;
    }
    get locked() { return this._locked; }
    _error(e) {
      if (this._state === 'errored') return;
      this._state = 'errored';
      this._err = e;
      if (this._closedRej) this._closedRej(e);
    }
    abort(e) {
      if (this._state === 'errored') return Promise.resolve();
      this._error(e);
      return Promise.resolve(this._sink.abort ? this._sink.abort(e) : undefined).then(() => undefined);
    }
    getWriter() {
      if (this._locked) throw new TypeError('WritableStream is locked');
      this._locked = true;
      const self = this;
      let res, rej;
      const closed = new Promise((a, b) => { res = a; rej = b; });
      closed.catch(() => {});
      this._closedRes = res;
      this._closedRej = rej;
      if (this._state === 'errored') rej(this._err);
      return {
        get closed() { return closed; },
        get ready() { return self._state === 'errored' ? Promise.reject(self._err) : Promise.resolve(); },
        get desiredSize() {
          if (self._state === 'errored') return null;
          return self._state === 'writable' ? 1 : 0;
        },
        write(chunk) {
          if (self._state === 'errored') return Promise.reject(self._err);
          if (self._state !== 'writable') return Promise.reject(new TypeError('cannot write to a ' + self._state + ' stream'));
          let r;
          try { r = self._sink.write(chunk); } catch (e) { self._error(e); return Promise.reject(e); }
          return Promise.resolve(r).catch((e) => { self._error(e); throw e; });
        },
        close() {
          if (self._state === 'errored') return Promise.reject(self._err);
          if (self._state !== 'writable') return Promise.reject(new TypeError('cannot close a ' + self._state + ' stream'));
          self._state = 'closed';
          let r;
          try { r = self._sink.close ? self._sink.close() : undefined; } catch (e) { self._state = 'errored'; self._err = e; rej(e); return Promise.reject(e); }
          return Promise.resolve(r).then(
            () => { res(); },
            (e) => { self._state = 'errored'; self._err = e; rej(e); throw e; },
          );
        },
        abort(e) { return self.abort(e); },
        releaseLock() { self._locked = false; },
      };
    }
  }

  const pump = (rs, ws) => {
    const reader = rs.getReader();
    const writer = ws.getWriter();
    const step = () =>
      reader.read().then((r) => {
        if (r.done) return writer.close();
        return writer.write(r.value).then(step);
      });
    step().catch((e) => {
      writer.abort(e).catch(() => {});
      reader.cancel(e).catch(() => {});
    });
  };

  class TransformStream {
    constructor(transformer, _ws, _rs) {
      if (transformer === undefined || transformer === null) transformer = {};
      if (transformer.readableType !== undefined || transformer.writableType !== undefined) {
        throw new RangeError('readableType/writableType are not supported in the scriptc island');
      }
      const t = transformer;
      const self = this;
      let rc = null;
      this._readable = new ReadableStream({
        start(c) { rc = c; },
        cancel(reason) { self._writable._error(reason); },
      });
      const tc = {
        enqueue(chunk) { rc.enqueue(chunk); },
        error(e) {
          self._readable._errorStream(e);
          self._writable._error(e);
        },
        terminate() {
          if (self._readable._state === 'readable' && !self._readable._closeRequested) rc.close();
          self._writable._error(new TypeError('The transform stream has been terminated'));
        },
        get desiredSize() { return rc.desiredSize; },
      };
      this._controller = tc;
      this._writable = new WritableLite({
        /* Eager transform: writes run the transformer immediately (no
         * readable-side backpressure) — order-exact, documented. */
        write(chunk) {
          let r;
          try { r = t.transform ? t.transform(chunk, tc) : tc.enqueue(chunk); } catch (e) { tc.error(e); throw e; }
          return Promise.resolve(r).catch((e) => { tc.error(e); throw e; });
        },
        close() {
          let r;
          try { r = t.flush ? t.flush(tc) : undefined; } catch (e) { tc.error(e); throw e; }
          return Promise.resolve(r).then(
            () => {
              if (self._readable._state === 'readable' && !self._readable._closeRequested) rc.close();
            },
            (e) => { tc.error(e); throw e; },
          );
        },
        abort(e) { self._readable._errorStream(e); },
      });
      if (t.start) t.start(tc); // sync start, like eventsource-parser needs
    }
    get readable() { return this._readable; }
    get writable() { return this._writable; }
  }

  g.ReadableStream = ReadableStream;
  g.TransformStream = TransformStream;
}

