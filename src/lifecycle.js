export function createCleanupScope(report = error => console.warn('[Group Utilities] Cleanup failed', error)) {
    let closed = false;
    const actions = [];
    return {
        get closed() { return closed; },
        add(action) {
            if (closed) { action(); return; }
            actions.push(action);
        },
        dispose() {
            if (closed) return;
            closed = true;
            for (const action of actions.splice(0).reverse()) {
                try { action(); } catch (error) { report(error); }
            }
        },
    };
}

export async function initializeModule(state, name, loader) {
    state.loadedModules ??= new Set();
    state.loadingModules ??= new Map();
    state.moduleCleanups ??= new Map();
    if (state.bundleDisabled) return false;
    if (state.loadedModules.has(name)) return true;
    if (state.loadingModules.has(name)) return state.loadingModules.get(name);
    const loading = Promise.resolve().then(async () => {
        try {
            const module = await loader();
            const cleanup = (await module.initialize()) ?? module.cleanup;
            if (state.bundleDisabled) { cleanup?.(); return false; }
            if (cleanup) state.moduleCleanups.set(name, cleanup);
            state.loadedModules.add(name);
            return true;
        } catch (error) {
            console.error(`[SillyBunny Group Utilities] Failed to initialize ${name}`, error);
            return false;
        } finally {
            state.loadingModules.delete(name);
        }
    });
    state.loadingModules.set(name, loading);
    return loading;
}
