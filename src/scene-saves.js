const DELETE_WINDOW_MS = 1500;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A swipe that generates points past the stored versions until its reply is stored; if none is, endSwipe
 * puts the old version back after the round, unsaved (script.js:16061-16101).
 */
export function isEmptySlot(message) {
    if (!isRecord(message) || !Array.isArray(message.swipes)) return false;
    const version = Number.isInteger(message.swipe_id) && message.swipe_id >= 0 ? message.swipe_id : 0;
    return version >= message.swipes.length && !isRecord(message.swipe_info?.[version]);
}

/**
 * Every scene memory chat save goes through here. It saves only a header seen loaded for the open chat,
 * never an empty chat or one whose newest line shows an empty swipe slot, and passes allowShrink only
 * right after a delete in the same chat.
 */
export function createChatSaver({ host, now = Date.now, log = console.warn }) {
    let loaded = new WeakMap();
    let unsaved = false;
    let deleted;
    let warned = false;
    const listeners = new Set();
    const currentKey = () => host.activeConversation()?.key;

    function markLoaded(meta, key) {
        if (meta && typeof meta === 'object' && typeof key === 'string') loaded.set(meta, key);
    }

    function isLoaded() {
        const meta = host.chatMetadata();
        const key = currentKey();
        return Boolean(meta && key && loaded.get(meta) === key);
    }

    async function save() {
        const key = currentKey();
        const chat = host.getContext().chat;
        if (!isLoaded() || !Array.isArray(chat) || chat.length === 0 || isEmptySlot(chat[chat.length - 1])) return false;
        // deleteMessage queued a debounced allowShrink save; this save replaces it (§J.4).
        const shrink = deleted?.key === key && now() - deleted.time <= DELETE_WINDOW_MS;
        // Header fields replaced while the save is in flight are not on disk yet; listeners judge by this copy.
        const carried = { ...host.chatMetadata() };
        let ok = false;
        try { ok = await host.saveChat(shrink ? { allowShrink: true } : {}) === true; }
        catch (error) { ok = false; log('[Group Utilities] Scene memory save failed', error); }
        if (ok) unsaved = false;
        else if (!warned) {
            warned = true;
            log('[Group Utilities] The chat was not saved; scene memory keeps its changes for the next save.');
        }
        for (const listener of [...listeners]) {
            try { listener(ok, key, carried); } catch (error) { log('[Group Utilities] Scene memory save listener failed', error); }
        }
        return ok;
    }

    return {
        markLoaded,
        adopt() { markLoaded(host.chatMetadata(), currentKey()); },
        isLoaded,
        noteDelete() { deleted = { key: currentKey(), time: now() }; },
        save,
        markUnsaved() { unsaved = true; },
        clearUnsaved() { unsaved = false; },
        hasUnsaved: () => unsaved,
        flush: () => unsaved ? save() : Promise.resolve(false),
        reset() { unsaved = false; deleted = undefined; },
        onSaved(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        destroy() { listeners.clear(); loaded = new WeakMap(); },
    };
}
