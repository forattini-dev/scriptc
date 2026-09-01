    /* node:perf_hooks — performance with a real monotonic-ish clock
     * (Date.now against the module's load origin; the island has no
     * hrtime source) and inert mark/measure bookkeeping. undici's
     * fetch/util.js destructures { performance } UNGUARDED at load. */
  builtins.perf_hooks = memo(() => {
    const timeOrigin = Date.now();
    const performance = {
      timeOrigin,
      now: () => Date.now() - timeOrigin,
      mark: () => ({}),
      measure: () => ({}),
      clearMarks: () => {},
      clearMeasures: () => {},
      getEntries: () => [],
      getEntriesByName: () => [],
      getEntriesByType: () => [],
      eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
    };
    class PerformanceObserver {
      constructor() {}
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    }
    PerformanceObserver.supportedEntryTypes = [];
    const ph = {
      performance, PerformanceObserver,
      monitorEventLoopDelay: () => ({ enable: () => {}, disable: () => {}, reset: () => {}, min: 0, max: 0, mean: 0, stddev: 0, percentile: () => 0 }),
      constants: {},
    };
    ph.default = ph;
    return ph;
  });
