    /* node:v8 — LOADABLE with Node's surface shape. Prettier's bundled
     * error helpers call startupSnapshot.isBuildingSnapshot() (inside a
     * try/catch) on every CLI start, so the module must import cleanly
     * and that one question must answer for real: the island is never a
     * snapshot build, so false — and the snapshot mutators throw Node's
     * ERR_NOT_BUILDING_SNAPSHOT exactly as a regular Node process does.
     * Heap statistics follow the os-shim's inert-half rule (all of
     * Node's keys, zero values — the embedded engine has no V8 heap to
     * report), flag/coverage entries are Node's own no-op paths, and the
     * V8-specific serialization wire format (serialize/deserialize and
     * the (De)Serializer classes) fences loudly at the call — the
     * embedded engine cannot produce or consume V8 serialization data. */
  builtins.v8 = memo(() => {
    const fence = (what) => () => { throw new Error("node:v8 '" + what + "' is not supported in the scriptc island (the embedded engine has no V8 heap or serialization format)"); };
    const notBuilding = () => {
      const e = new Error('Operation cannot be invoked when not building startup snapshot');
      e.code = 'ERR_NOT_BUILDING_SNAPSHOT';
      throw e;
    };
    const startupSnapshot = {
      isBuildingSnapshot: () => false,
      addSerializeCallback: notBuilding,
      addDeserializeCallback: notBuilding,
      setDeserializeMainFunction: notBuilding,
    };
    class FencedClass { constructor() { fence(new.target.name)(); } }
    class Serializer extends FencedClass {}
    class Deserializer extends FencedClass {}
    class DefaultSerializer extends FencedClass {}
    class DefaultDeserializer extends FencedClass {}
    class GCProfiler extends FencedClass {}
    const v8 = {
      startupSnapshot,
      cachedDataVersionTag: () => 0,
      getHeapStatistics: () => ({ total_heap_size: 0, total_heap_size_executable: 0, total_physical_size: 0, total_available_size: 0, used_heap_size: 0, heap_size_limit: 0, malloced_memory: 0, peak_malloced_memory: 0, does_zap_garbage: 0, number_of_native_contexts: 0, number_of_detached_contexts: 0, total_global_handles_size: 0, used_global_handles_size: 0, external_memory: 0 }),
      getHeapSpaceStatistics: () => [],
      getHeapCodeStatistics: () => ({ code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }),
      getCppHeapStatistics: () => ({}),
      setFlagsFromString: () => undefined,
      takeCoverage: () => undefined,
      stopCoverage: () => undefined,
      setHeapSnapshotNearHeapLimit: () => undefined,
      serialize: fence('serialize'),
      deserialize: fence('deserialize'),
      writeHeapSnapshot: fence('writeHeapSnapshot'),
      getHeapSnapshot: fence('getHeapSnapshot'),
      queryObjects: fence('queryObjects'),
      startCpuProfile: fence('startCpuProfile'),
      isStringOneByteRepresentation: fence('isStringOneByteRepresentation'),
      promiseHooks: { onInit: fence('promiseHooks.onInit'), onSettled: fence('promiseHooks.onSettled'), onBefore: fence('promiseHooks.onBefore'), onAfter: fence('promiseHooks.onAfter'), createHook: fence('promiseHooks.createHook') },
      Serializer, Deserializer, DefaultSerializer, DefaultDeserializer, GCProfiler,
    };
    v8.default = v8;
    return v8;
  });
