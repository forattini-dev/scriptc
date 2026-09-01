/* The embedded npm module graph the island realm resolves against.
 *
 * `--dynamic` builds embed every reached module's SOURCE as a static
 * string plus the (importer, specifier) → target edges the compiler's
 * resolver walked at build time; binaries never read node_modules at
 * runtime. This file owns the tables and the two lookups over them —
 * the module loader and the CommonJS require shim in `island_eval.rs`
 * are their only readers.
 */

/// How a module's stored `source` must be evaluated.
///
/// `Cjs` modules additionally carry `esm`: the facade synthesized at
/// BUILD time (default plus the named exports lexed from the source),
/// which is what the ES module graph evaluates when it imports the file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IslandModuleFormat {
    Esm,
    Cjs,
    Json,
}

#[derive(Clone, Copy)]
pub struct IslandModule {
    pub key: &'static str,
    pub source: &'static str,
    pub format: IslandModuleFormat,
    pub esm: Option<&'static str>,
}

/// Which call form an edge was resolved for.
///
/// One `(from, specifier)` pair can carry two edges when a dual package's
/// "exports" map names different files under the "import" and "require"
/// conditions; `Any` (relative files, builtins) serves both lookups.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IslandEdgeKind {
    Any,
    Import,
    Require,
}

#[derive(Clone, Copy)]
pub struct IslandEdge {
    pub from: &'static str,
    pub specifier: &'static str,
    pub to: &'static str,
    pub kind: IslandEdgeKind,
}

thread_local! {
    static ISLAND_MODULES: RefCell<&'static [IslandModule]> = const { RefCell::new(&[]) };
    static ISLAND_EDGES: RefCell<&'static [IslandEdge]> = const { RefCell::new(&[]) };
}

/// Install the embedded module table. Emitted `main` calls this before
/// any generated code can reach the island.
pub fn island_register_modules(modules: &'static [IslandModule]) {
    ISLAND_MODULES.with(|slot| *slot.borrow_mut() = modules);
}

/// Install the resolution edge table, alongside the module table.
pub fn island_register_edges(edges: &'static [IslandEdge]) {
    ISLAND_EDGES.with(|slot| *slot.borrow_mut() = edges);
}

pub(crate) fn island_registered_modules() -> &'static [IslandModule] {
    ISLAND_MODULES.with(|slot| *slot.borrow())
}

pub(crate) fn island_module_find(key: &str) -> Option<&'static IslandModule> {
    island_registered_modules()
        .iter()
        .find(|module| module.key == key)
}

/// Resolve `(from, specifier)` for one call form, mirroring the island's
/// C loader.
///
/// `want` is the LOOKUP's kind — the ES module loader asks with `Import`,
/// the require shim with `Require`. An import lookup missing its own kind
/// falls back to a require edge (a build-time-invisible `import()` of a
/// specifier the file only `require`s loads the CJS entry through its
/// facade, which is the module Node's require condition serves), but a
/// require lookup NEVER falls back: import-kind edges can target real ES
/// modules, and MODULE_NOT_FOUND is the honest answer for a require the
/// build never resolved.
pub(crate) fn island_edge_find(
    from: &str,
    specifier: &str,
    want: IslandEdgeKind,
) -> Option<&'static str> {
    let mut fallback = None;
    for edge in ISLAND_EDGES.with(|slot| *slot.borrow()) {
        if edge.from != from || edge.specifier != specifier {
            continue;
        }
        if edge.kind == IslandEdgeKind::Any || edge.kind == want {
            return Some(edge.to);
        }
        if want == IslandEdgeKind::Import && edge.kind == IslandEdgeKind::Require {
            fallback = Some(edge.to);
        }
    }
    fallback
}

/// Drop both tables. Island teardown runs this so a re-entered realm
/// cannot observe a previous program's graph.
pub(crate) fn island_modules_reset() {
    ISLAND_MODULES.with(|slot| *slot.borrow_mut() = &[]);
    ISLAND_EDGES.with(|slot| *slot.borrow_mut() = &[]);
}
