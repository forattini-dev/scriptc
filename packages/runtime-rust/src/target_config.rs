// The runtime TARGET a compiled program reproduces — the per-runtime
// semantic switches the compiler's --target profile selects (compat/
// runtime-target.ts). The generated program calls `target_configure`
// right after `init`; a program that never does (older IR, library
// archives) runs the matrix primary's semantics, which every default
// below spells.

/// `Readable.prototype.read()` bare form (nodejs#60441): Node 24 collapses
/// the whole paused queue, Node 26 hands back the head chunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadRule {
    CollapseQueue,
    HeadChunk,
}

#[derive(Clone, Copy, Debug)]
pub struct TargetConfig {
    pub runtime_id: &'static str,
    pub node_version: &'static str,
    pub readable_bare_read: ReadRule,
}

const PRIMARY_TARGET: TargetConfig = TargetConfig {
    runtime_id: "node24",
    node_version: NODE_COMPAT_VERSION,
    readable_bare_read: ReadRule::CollapseQueue,
};

thread_local! {
    static TARGET: Cell<TargetConfig> = const { Cell::new(PRIMARY_TARGET) };
}

/// Selects the runtime target for this thread's program. Called once by
/// the generated entry before any program code runs.
pub fn target_configure(config: TargetConfig) {
    TARGET.with(|target| target.set(config));
}

pub fn target_config() -> TargetConfig {
    TARGET.with(Cell::get)
}

pub fn target_readable_bare_read() -> ReadRule {
    target_config().readable_bare_read
}

pub fn target_node_version() -> &'static str {
    target_config().node_version
}

pub fn target_runtime_id() -> &'static str {
    target_config().runtime_id
}
