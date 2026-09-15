const statuses = new Set(['present', 'absent', 'remote']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key);

function inspectStored(value) {
    if (value == null) return { supported: true, data: { version: 1, chats: {} }, warning: '' };
    const unsupported = () => ({ supported: false, data: null,
        warning: 'Saved current-scene data has an unsupported format. It is preserved; scene editing is unavailable.' });
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.chats)) return unsupported();
    for (const [key, chat] of Object.entries(value.chats)) {
        if (!key || !isRecord(chat) || !isRecord(chat.members)) return unsupported();
        if (Object.entries(chat.members).some(([avatar, status]) => !avatar || !statuses.has(status))) return unsupported();
    }
    return { supported: true, data: value, warning: '' };
}

/** Current scene settings only: no transcript writes, historical witnesses or executable work. */
export function createSceneStore({ host, settings }) {
    let destroyed = false;
    let revision = 0;
    const listeners = new Set();
    const cleanups = [];

    function capture() {
        const active = host.activeConversation();
        const key = typeof active?.key === 'string' && active.key ? active.key : undefined;
        const config = settings.get();
        const enabled = config.scene_controls === true;
        const stored = inspectStored(config.current_scenes);
        const roster = key ? host.resolveMembers() : [];
        const counts = new Map();
        for (const member of roster) {
            if (typeof member?.avatar === 'string' && member.avatar) {
                counts.set(member.avatar, (counts.get(member.avatar) ?? 0) + 1);
            }
        }
        const members = roster.filter(member => typeof member?.avatar === 'string' && member.avatar
            && counts.get(member.avatar) === 1);
        const chat = stored.supported && key && own(stored.data.chats, key) ? stored.data.chats[key] : undefined;
        const savedMembers = chat?.members ?? {};
        const participants = members.map(member => {
            const status = own(savedMembers, member.avatar) ? savedMembers[member.avatar] : 'unspecified';
            return { avatar: member.avatar, name: String(member.name ?? ''), status,
                reachable: !enabled || (stored.supported && status !== 'absent') };
        });
        const identities = new Set(participants.map(member => member.avatar));
        const orphaned = Object.keys(savedMembers).filter(avatar => !identities.has(avatar));
        const warnings = [stored.warning];
        if (!key) warnings.push('Open a group conversation to configure its current scene.');
        if (roster.length !== members.length) warnings.push('Some members have missing or ambiguous card identities and cannot be configured.');
        if (orphaned.length) warnings.push('Saved state for unavailable cards is preserved without assigning it to another card.');
        return { stored, snapshot: { key, enabled, supported: stored.supported, participants, orphaned,
            warning: warnings.filter(Boolean).join(' '), revision } };
    }

    function notify() {
        if (destroyed) return;
        revision++;
        for (const listener of listeners) {
            try { listener(); } catch (error) { console.warn('[Group Utilities] Scene view failed', error); }
        }
    }

    function getSnapshot() { return capture().snapshot; }

    function memberGuard(avatar, expectedKey) {
        const captured = capture();
        const { snapshot } = captured;
        if (destroyed) return { ...captured, reason: 'Scene controls are unavailable.' };
        if (!snapshot.key || (expectedKey !== undefined && expectedKey !== snapshot.key)) {
            return { ...captured, reason: 'The active conversation has changed.' };
        }
        const member = snapshot.participants.find(participant => participant.avatar === avatar);
        if (!member) return { ...captured, reason: 'This exact character card is unavailable in the active conversation.' };
        return { ...captured, member, reason: '' };
    }

    function update(patch) {
        try {
            settings.update(patch);
            return { ok: true, reason: '' };
        } catch (error) {
            console.warn('[Group Utilities] Scene settings update failed', error);
            return { ok: false, reason: 'Current-scene settings could not be saved.' };
        }
    }

    function setState(avatar, status, expectedKey) {
        const { snapshot, stored, member, reason } = memberGuard(avatar, expectedKey);
        if (reason) return { ok: false, reason };
        if (!stored.supported) return { ok: false, reason: snapshot.warning };
        if (!statuses.has(status) && status !== 'unspecified') return { ok: false, reason: 'Choose an available current-scene state.' };
        if (member.status === status) return { ok: true, reason: '' };
        const previousChat = own(stored.data.chats, snapshot.key) ? stored.data.chats[snapshot.key] : { members: {} };
        const nextMembers = { ...previousChat.members };
        if (status === 'unspecified') delete nextMembers[avatar];
        else Object.defineProperty(nextMembers, avatar, { value: status, enumerable: true, configurable: true, writable: true });
        const current_scenes = { ...stored.data, chats: { ...stored.data.chats,
            [snapshot.key]: { ...previousChat, members: nextMembers } } };
        return update({ current_scenes });
    }

    function setEnabled(enabled) {
        if (destroyed) return { ok: false, reason: 'Scene controls are unavailable.' };
        if (typeof enabled !== 'boolean') return { ok: false, reason: 'Scene controls need an explicit enabled or disabled choice.' };
        const { snapshot } = capture();
        if (enabled && !snapshot.supported) return { ok: false, reason: snapshot.warning };
        if (snapshot.enabled === enabled) return { ok: true, reason: '' };
        return update({ scene_controls: enabled });
    }

    function canRespond(avatar, expectedKey) {
        const { snapshot, member, reason } = memberGuard(avatar, expectedKey);
        if (reason) return { allowed: false, reason };
        if (!snapshot.enabled) return { allowed: true, reason: '' };
        if (!snapshot.supported) return { allowed: false, reason: snapshot.warning };
        return member.reachable ? { allowed: true, reason: '' }
            : { allowed: false, reason: 'This character is explicitly absent from the current scene.' };
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch (error) { console.warn('[Group Utilities] Scene cleanup failed', error); }
        }
        listeners.clear();
    }

    try {
        cleanups.push(settings.subscribe(notify));
        cleanups.push(host.onContextChanged(notify));
    } catch (error) { destroy(); throw error; }
    return { getSnapshot, setState, setEnabled, canRespond, destroy,
        subscribe(listener) {
            if (destroyed) return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        } };
}
