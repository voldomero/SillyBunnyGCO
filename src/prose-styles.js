const className = 'sbu-prose-styles';

/** Styles existing host prose markup; never reads or rewrites message contents. */
export function createProseStyles({ host, settings, document = globalThis.document }) {
    let destroyed = false;
    const cleanups = [() => document?.body?.classList.remove(className)];

    function refresh() {
        if (destroyed) return;
        let enabled = false;
        try {
            if (settings.get().prose_styles === true) {
                const key = host.activeConversation()?.key;
                enabled = typeof key === 'string' && key.length > 0;
            }
        } finally {
            document?.body?.classList.toggle(className, enabled);
        }
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const cleanup of cleanups.splice(0).reverse()) {
            try { cleanup(); } catch (error) { console.warn('[Group Utilities] Prose styling cleanup failed', error); }
        }
    }

    try {
        cleanups.push(settings.subscribe(refresh));
        cleanups.push(host.onContextChanged(refresh));
        refresh();
    } catch (error) {
        destroy();
        throw error;
    }

    return { destroy };
}
