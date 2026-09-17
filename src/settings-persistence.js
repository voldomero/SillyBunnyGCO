const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => isRecord(object) && Object.hasOwn(object, key);
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const absent = () => ({ present: false });
const cell = (object, key) => own(object, key) ? { present: true, value: clone(object[key]) } : absent();
const define = (object, key, value) => Object.defineProperty(object, key,
    { value, writable: true, enumerable: true, configurable: true });
const statuses = new Set(['present', 'absent', 'remote']);
const pathKey = path => JSON.stringify(path);

function supportedScene(value) {
    if (!value.present || value.value === null) return true;
    const scene = value.value;
    return isRecord(scene) && scene.version === 1 && isRecord(scene.chats)
        && Object.entries(scene.chats).every(([key, chat]) => key && isRecord(chat) && isRecord(chat.members)
            && Object.entries(chat.members).every(([avatar, status]) => avatar && statuses.has(status)));
}

function read(snapshot, path) {
    if (path[0] === 'enabled') return { supported: true, cell: snapshot.enabled };
    if (path[0] === 'note') {
        const notes = snapshot.notes;
        return { supported: !notes.present || isRecord(notes.value), cell: cell(notes.value, path[1]) };
    }
    return { supported: supportedScene(snapshot.scenes),
        cell: cell(snapshot.scenes.value?.chats?.[path[1]]?.members, path[2]) };
}

function paths(snapshot) {
    const result = [['enabled']];
    if (isRecord(snapshot.notes.value)) {
        for (const avatar of Object.keys(snapshot.notes.value)) result.push(['note', avatar]);
    }
    if (supportedScene(snapshot.scenes) && snapshot.scenes.value) {
        for (const [key, chat] of Object.entries(snapshot.scenes.value.chats)) {
            for (const avatar of Object.keys(chat.members)) result.push(['scene', key, avatar]);
        }
    }
    return result;
}

function validCell(value) {
    return isRecord(value) && (value.present === false
        || (value.present === true && Object.hasOwn(value, 'value')));
}

function validEntry(entry) {
    if (!isRecord(entry) || !Array.isArray(entry.path) || !validCell(entry.base) || !validCell(entry.target)) return false;
    const [kind, ...keys] = entry.path;
    if (keys.some(key => typeof key !== 'string' || !key)) return false;
    if (kind === 'enabled') return keys.length === 0
        && (!entry.target.present || typeof entry.target.value === 'boolean');
    if (kind === 'note') return keys.length === 1
        && (!entry.target.present || typeof entry.target.value === 'string');
    return kind === 'scene' && keys.length === 2
        && (!entry.target.present || statuses.has(entry.target.value));
}

function apply(settings, path, target) {
    let object = settings;
    let key = 'scene_controls';
    if (path[0] === 'note') {
        if (!own(settings, 'character_notes')) define(settings, 'character_notes', {});
        object = settings.character_notes;
        key = path[1];
    } else if (path[0] === 'scene') {
        if (!own(settings, 'current_scenes') || settings.current_scenes === null) {
            define(settings, 'current_scenes', { version: 1, chats: {} });
        }
        const chats = settings.current_scenes.chats;
        if (!own(chats, path[1])) define(chats, path[1], { members: {} });
        object = chats[path[1]].members;
        key = path[2];
    }
    if (target.present) define(object, key, clone(target.value));
    else delete object[key];
}

/**
 * Recover only explicit note/current-scene edits through an injected per-account,
 * per-tab storage boundary. The host remains the sole server settings writer.
 * capture() precedes a mutation; record(before) synchronously journals it and
 * returns whether any tracked field changed. save() must return exactly true
 * to acknowledge a save. Unknown formats and conflicting edits are retained.
 */
export function createSettingsPersistence({ getSettings, storage, storageKey, save, onChange = () => {},
    setTimeout: schedule = globalThis.setTimeout, clearTimeout: unschedule = globalThis.clearTimeout, debounceMs = 300 }) {
    let entries = [];
    let unreadableJournal;
    let lastRaw = null;
    let loaded = false;
    let restored = false;
    let destroyed = false;
    let storageUnsafe = false;
    let dataUnsafe = false;
    let failed = false;
    let confirmed = false;
    let timer;
    let running;
    let again = false;
    let nextId = 0;
    let locked = new Set();
    let previousStatus = '';

    function getStatus() {
        const pending = entries.filter(entry => !entry.conflict).length;
        const conflicts = entries.filter(entry => entry.conflict).length;
        const unsafe = storageUnsafe || dataUnsafe;
        let message = '';
        if (unsafe) message = 'Recovery could not be stored safely in this tab. Keep it open or download a recovery copy.';
        else if (conflicts) message = 'Some recovered edits conflict with saved settings. Saved values were kept; download a recovery copy to review the pending edits.';
        else if (pending && failed) message = 'Changes are kept in this tab for recovery after reload, but SillyBunny has not confirmed saving them yet.';
        else if (pending) message = 'Saving changes. A recovery copy is kept in this tab until SillyBunny confirms the save.';
        else if (confirmed) message = 'Changes saved to SillyBunny.';
        return { message, pending, conflicts, unsafe };
    }

    function notify() {
        if (destroyed) return;
        const status = getStatus();
        const signature = JSON.stringify(status);
        if (signature === previousStatus) return;
        previousStatus = signature;
        try { onChange(status); } catch (error) { console.warn('[Group Utilities] Save status update failed', error); }
    }

    function load() {
        if (loaded || destroyed) return;
        loaded = true;
        if (!storage || typeof storageKey !== 'string' || !storageKey) return;
        try {
            lastRaw = storage.getItem(storageKey);
            if (lastRaw === null) return;
            const journal = JSON.parse(lastRaw);
            if (!isRecord(journal) || journal.version !== 1 || !Array.isArray(journal.entries)
                || !journal.entries.every(validEntry)) throw new Error('Unsupported recovery data');
            entries = journal.entries.map(entry => ({ ...clone(entry), id: ++nextId, conflict: entry.conflict === true }));
        } catch {
            unreadableJournal = lastRaw ?? undefined;
            storageUnsafe = true;
        }
    }

    function write() {
        if (destroyed) return false;
        if (unreadableJournal !== undefined || !storage || typeof storageKey !== 'string' || !storageKey) {
            storageUnsafe = true;
            return false;
        }
        try {
            // Also protect against another instance unexpectedly sharing this key.
            if (storage.getItem(storageKey) !== lastRaw) throw new Error('Recovery storage changed');
            const raw = entries.length ? JSON.stringify({ version: 1, entries }) : null;
            if (raw !== lastRaw) {
                if (raw === null) storage.removeItem(storageKey);
                else storage.setItem(storageKey, raw);
                lastRaw = raw;
            }
            storageUnsafe = false;
            return true;
        } catch {
            storageUnsafe = true;
            return false;
        }
    }

    function capture() {
        if (destroyed) return null;
        try {
            const settings = getSettings();
            if (!isRecord(settings)) throw new Error('Settings unavailable');
            return { notes: cell(settings, 'character_notes'), enabled: cell(settings, 'scene_controls'),
                scenes: cell(settings, 'current_scenes') };
        } catch {
            dataUnsafe = true;
            notify();
            return null;
        }
    }

    function cancelTimer() {
        if (timer !== undefined) unschedule(timer);
        timer = undefined;
    }

    function queue() {
        if (destroyed || !entries.some(entry => !entry.conflict)) return;
        if (running) { again = true; return; }
        if (timer !== undefined) return;
        timer = schedule(() => { timer = undefined; void flush(); }, debounceMs);
    }

    function record(before) {
        if (destroyed || !before) return false;
        load();
        const after = capture();
        if (!after || equal(before, after)) return false;
        const candidates = new Map([...paths(before), ...paths(after)].map(path => [pathKey(path), path]));
        let changed = false;
        for (const path of candidates.values()) {
            const original = read(before, path);
            const current = read(after, path);
            if (equal(original.cell, current.cell) && original.supported === current.supported) continue;
            changed = true;
            const entry = { path, base: original.cell, target: current.cell, id: ++nextId, conflict: false };
            if (!original.supported || !current.supported || !validEntry(entry)) { dataUnsafe = true; continue; }
            const previous = entries.findLast(item => !item.conflict && pathKey(item.path) === pathKey(path));
            if (previous && !equal(previous.target, original.cell)) previous.conflict = true;
            // Other native controls can save the shared settings at any time.
            // Retain each transition even before our own request begins.
            entries.push(entry);
        }
        if (!changed) return false;
        failed = false;
        confirmed = false;
        write();
        queue();
        notify();
        return true;
    }

    function restore() {
        if (destroyed || restored) return false;
        restored = true;
        load();
        const snapshot = capture();
        if (!snapshot) return false;
        let changed = false;
        const groups = new Map();
        for (const entry of entries) {
            if (entry.conflict) continue;
            const key = pathKey(entry.path);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
        }
        for (const chain of groups.values()) {
            const current = read(snapshot, chain[0].path);
            if (!current.supported) { for (const entry of chain) entry.conflict = true; continue; }
            // The server may have committed an intermediate save before the page
            // disappeared. Skip that prefix when replaying, but keep its recovery
            // record until a fresh save acknowledges the latest value. A request
            // from the previous page might still be reaching the server.
            const savedThrough = chain.findLastIndex(entry => equal(current.cell, entry.target));
            let value = current.cell;
            for (const entry of chain.slice(savedThrough + 1)) {
                if (!equal(value, entry.base)) { entry.conflict = true; continue; }
                try {
                    apply(getSettings(), entry.path, entry.target);
                    value = entry.target;
                    changed = true;
                } catch { entry.conflict = true; dataUnsafe = true; }
            }
        }
        if (entries.length || lastRaw !== null) write();
        queue();
        notify();
        return changed;
    }

    async function run() {
        let acknowledged = false;
        do {
            again = false;
            const snapshot = capture();
            if (!snapshot || destroyed) break;
            const batch = entries.filter(entry => !entry.conflict);
            if (!batch.length) break;
            const targets = new Map(batch.map(entry => [pathKey(entry.path), entry]));
            for (const entry of targets.values()) {
                const current = read(snapshot, entry.path);
                if (!current.supported || !equal(current.cell, entry.target)) {
                    for (const item of batch.filter(item => pathKey(item.path) === pathKey(entry.path))) item.conflict = true;
                }
            }
            const submitted = batch.filter(entry => !entry.conflict);
            locked = new Set(submitted.map(entry => entry.id));
            write();
            notify();
            if (destroyed) return false;
            if (!submitted.length) break;
            let result;
            try { result = await save(); } catch { result = false; }
            if (destroyed) return false;
            acknowledged = result === true;
            failed = !acknowledged;
            if (acknowledged) {
                const current = capture();
                const clear = new Set();
                if (current) {
                    for (const target of targets.values()) {
                        const value = read(current, target.path);
                        if (!target.conflict && value.supported && equal(value.cell, target.target)) {
                            for (const entry of submitted) {
                                if (pathKey(entry.path) === pathKey(target.path) && locked.has(entry.id)) clear.add(entry);
                            }
                        }
                    }
                }
                entries = entries.filter(entry => !clear.has(entry));
                confirmed = entries.length === 0;
            }
            locked = new Set();
            write();
            notify();
        } while (again && !destroyed);
        return acknowledged;
    }

    function flush() {
        if (destroyed) return Promise.resolve(false);
        load();
        cancelTimer();
        if (running) { again = true; return running; }
        running = Promise.resolve().then(run).finally(() => { running = undefined; locked = new Set(); });
        return running;
    }

    function getRecovery() {
        load();
        return clone({ version: 1, entries, ...(unreadableJournal !== undefined ? { unreadableJournal } : {}) });
    }

    function destroy() {
        destroyed = true;
        cancelTimer();
        again = false;
    }

    return { capture, record, restore, flush, getStatus, getRecovery, destroy };
}
