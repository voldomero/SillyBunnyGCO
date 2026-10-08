// Siblings load with this module's asset token, as groupUtils.js does, so a GCO update never mixes cached files.
const sibling = path => {
    const url = new URL(path, import.meta.url);
    const token = new URL(import.meta.url).searchParams.get('v') ?? globalThis.window?.SillyBunnyGroupUtilities?.assetToken;
    if (token) url.searchParams.set('v', token);
    return url.href;
};
const [{ foundersSnapshot, memoryActive, readRevealPairs }, {
    ROSTER_KEY, addRevealPair, clampJoins, dropRevealPair, joinWindowFor, newestTime, oldestTime,
    readRoster, reconcileRoster, removeJoin, renameInRoster, revealsFor, timeOf: readTime,
}] = await Promise.all([import(sibling('./settings.js')), import(sibling('./scene-roster.js'))]);

const FILE_TRIGGERS = new Set(['init', 'turn-on', 'CHAT_CHANGED']);
const CLAMP_TYPES = new Set(['normal', 'swipe', 'continue', 'append', 'appendFinal', 'command', 'first_message']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const define = (object, key, value) => Object.defineProperty(object, key, {
    value, writable: true, enumerable: true, configurable: true,
});
const storedRosterOf = meta => isRecord(meta) && Object.hasOwn(meta, ROSTER_KEY) ? meta[ROSTER_KEY] : undefined;
const noChange = () => ({ changed: false, save: null, announce: [], warning: null });

/** Pending pairs for this chat whose avatar the roster already lists as known with no join, dropped; null when none. */
function settledReveals(roster, pairs, chatKey) {
    if (!roster) return null;
    const known = new Set(roster.known);
    const joined = new Set(roster.joined.map(([avatar]) => avatar));
    const settled = revealsFor(pairs, chatKey).filter(avatar => known.has(avatar) && !joined.has(avatar));
    if (!settled.length) return null;
    return settled.reduce((list, avatar) => dropRevealPair(list, chatKey, avatar), pairs);
}

/**
 * The founders list for the open group and, when the snapshot needs upkeep, its replacement:
 * a new snapshot when its `since` is not the token, the group added when it is missing.
 */
function foundersFor(config, groupId, members) {
    const token = config.scene_history_since;
    const stored = config.scene_history_founders;
    const groupKey = String(groupId);
    const own = foundersSnapshot([{ id: groupId, members }], token);
    const list = own.groups[groupKey] ?? [];
    if (!isRecord(stored) || stored.since !== token || !isRecord(stored.groups)) return { list, snapshot: own };
    if (Object.hasOwn(stored.groups, groupKey) && Array.isArray(stored.groups[groupKey])) {
        return { list: stored.groups[groupKey], snapshot: null };
    }
    const groups = {};
    for (const [key, value] of Object.entries(stored.groups)) define(groups, key, value);
    define(groups, groupKey, list);
    return { list, snapshot: { ...stored, groups } };
}

/**
 * The join check of the open group chat. It registers no events: the recorder calls `check`
 * first in its handlers and does the saving that `check(...).save` asks for.
 */
export function createJoinTracker({ host, settings, scene, saver, now = Date.now, log = console.warn }) {
    let cursor;
    let failed = false;
    const announced = new Set();
    const warned = new Set();
    const chatOf = () => {
        const chat = host.getContext().chat;
        return Array.isArray(chat) ? chat : [];
    };

    // host.timeOf rebuilds the whole host context per call; the file scans read the parser once instead.
    function lineTimes() {
        const parse = host.getContext().timestampToMoment;
        return value => readTime(value, parse);
    }

    function gate() {
        return memoryActive(settings.get()) && Boolean(host.activeConversation())
            && scene.getSnapshot().supported === true;
    }

    // While a reply streams, the last line is already dated but is not accounted for until MESSAGE_RECEIVED.
    function fileCursor(key, timeOf) {
        return { key, value: newestTime(chatOf(), timeOf, now(), { skipLast: host.isGenerating() === true }),
            fromFile: true };
    }

    /** Reconcile in memory; nothing is written. Null when the host has no header object. */
    function evaluate(active, config, pairs, position, timeOf) {
        const meta = host.chatMetadata();
        if (!meta) return null;
        const chat = chatOf();
        const token = config.scene_history_since;
        const members = host.memberIds();
        const stored = storedRosterOf(meta);
        const read = readRoster(stored);
        const founders = foundersFor(config, active.groupId, members);
        // Founders only count when the roster will be created or rebuilt; the O(n) date scan is skipped otherwise.
        const current = read.state === 'valid' && read.roster.group === String(active.groupId)
            && read.roster.since === token;
        let existed = false;
        if (!current && read.state !== 'foreign') {
            const oldest = oldestTime(chat, timeOf);
            existed = oldest !== null && oldest <= Date.parse(token);
        }
        const result = reconcileRoster({ stored, groupId: active.groupId, members, cards: host.cardAvatars(),
            founders: existed ? founders.list : [], reveals: revealsFor(pairs, active.key), chat, since: token,
            cursor: position.value, fromFile: position.fromFile, now: now(), timeOf });
        return { meta, chat, founders, result };
    }

    function storedJoin(active, avatar, pairs) {
        const { roster } = readRoster(storedRosterOf(host.chatMetadata()));
        if (!roster || roster.group !== String(active.groupId)) return undefined;
        if (revealsFor(pairs, active.key).includes(avatar)) return undefined;
        return joinWindowFor(roster, avatar);
    }

    const once = (seen, id) => !seen.has(id) && Boolean(seen.add(id));

    function saveIntent(trigger, index, type, chat) {
        if (FILE_TRIGGERS.has(trigger)) return null;
        if (trigger === 'MESSAGE_SENT') return 'await';
        if (trigger === 'MESSAGE_RECEIVED') {
            if (index < chat.length - 1) return 'await';
            if (type === 'command') return null;
        }
        return 'idle';
    }

    function raise(trigger, index, type, dryRun, chat, timeOf) {
        let line;
        if (trigger === 'MESSAGE_SENT' || trigger === 'MESSAGE_RECEIVED') line = chat[index];
        else if (trigger === 'GENERATION_STARTED' && type !== 'quiet' && !dryRun) line = chat[chat.length - 1];
        const time = isRecord(line) ? timeOf(line.send_date) : NaN;
        if (Number.isNaN(time)) return;
        const capped = Math.min(time, now());
        if (cursor.value === null || capped > cursor.value) cursor.value = capped;
    }

    function runCheck(trigger, active, { id, type, dryRun }) {
        const key = active.key;
        const timeOf = lineTimes();
        if (FILE_TRIGGERS.has(trigger) || cursor?.key !== key) cursor = fileCursor(key, timeOf);
        const config = settings.get();
        const patch = {};
        let pairs = readRevealPairs(config);
        if (trigger === 'CHAT_CHANGED') {
            const remaining = settledReveals(readRoster(storedRosterOf(host.chatMetadata())).roster, pairs, key);
            if (remaining) {
                pairs = remaining;
                patch.scene_join_reveals = remaining.length ? remaining : null;
            }
        }
        const run = evaluate(active, config, pairs, cursor, timeOf);
        if (!run) return noChange();
        const { meta, chat, founders, result } = run;
        if (founders.snapshot) patch.scene_history_founders = founders.snapshot;
        const writeSettings = () => { if (Object.keys(patch).length) settings.update(patch); };
        if (result.state === 'guarded' || result.state === 'foreign') {
            writeSettings();
            const warning = result.warning && once(warned, JSON.stringify([key, result.warning])) ? result.warning : null;
            return { ...noChange(), warning };
        }

        const index = Number(id);
        let next = result.next;
        const clamps = trigger === 'MESSAGE_SENT' || (trigger === 'MESSAGE_RECEIVED' && CLAMP_TYPES.has(type));
        if (clamps && index === chat.length - 1 && isRecord(chat[index])) {
            next = clampJoins(next, timeOf(chat[index].send_date));
        }
        const changed = result.changed || next !== result.next;
        // The header goes last: a throw before it reports no change, so it must leave nothing for a save to carry.
        writeSettings();
        if (changed) meta[ROSTER_KEY] = next;
        raise(trigger, index, type, dryRun, chat, timeOf);
        cursor.fromFile = false;
        return {
            changed,
            save: changed ? saveIntent(trigger, index, type, chat) : null,
            announce: result.joined.filter(avatar => once(announced, JSON.stringify([key, avatar]))),
            warning: result.warning && once(warned, JSON.stringify([key, result.warning])) ? result.warning : null,
        };
    }

    function check(trigger, { id, type, dryRun } = {}) {
        try {
            const active = host.activeConversation();
            if (trigger === 'CHAT_CHANGED' && active) saver.markLoaded(host.chatMetadata(), active.key);
            if (!gate()) return noChange();
            return runCheck(trigger, active, { id, type, dryRun });
        } catch (error) {
            if (!failed) {
                failed = true;
                log('[Group Utilities] Scene memory join check failed', error);
            }
            return noChange();
        }
    }

    /** The speaker's join time for the filter and the preview, including joins no trigger has recorded yet. */
    function joinTime(avatar) {
        if (!gate()) return undefined;
        const active = host.activeConversation();
        const config = settings.get();
        const pairs = readRevealPairs(config);
        let run;
        try {
            const timeOf = lineTimes();
            run = evaluate(active, config, pairs, cursor?.key === active.key ? cursor : fileCursor(active.key, timeOf),
                timeOf);
        } catch {
            return storedJoin(active, avatar, pairs);
        }
        if (!run) return undefined;
        if (run.result.state === 'guarded') return storedJoin(active, avatar, pairs);
        return joinWindowFor(run.result.next, avatar);
    }

    /** Join Undo: a reveal pair always; the header too when that chat is open. The caller saves. */
    function forgetJoin(avatar, chatKey) {
        const pairs = readRevealPairs(settings.get());
        const next = addRevealPair(pairs, chatKey, avatar);
        if (next === pairs) return { ok: false, applied: false };
        settings.update({ scene_join_reveals: next });
        if (host.activeConversation()?.key !== chatKey || !gate()) return { ok: true, applied: false };
        const meta = host.chatMetadata();
        const { roster } = readRoster(storedRosterOf(meta));
        if (roster) {
            const updated = removeJoin(roster, avatar);
            if (updated !== roster) meta[ROSTER_KEY] = updated;
        }
        return { ok: true, applied: true };
    }

    /** CHARACTER_RENAMED_IN_PAST_CHAT: the host saves that file itself, and no group is open then. */
    function rename(messages, from, to) {
        if (!memoryActive(settings.get())) return;
        const header = Array.isArray(messages) ? messages[0] : undefined;
        const meta = isRecord(header) && isRecord(header.chat_metadata) ? header.chat_metadata : undefined;
        const { roster } = readRoster(storedRosterOf(meta));
        if (!roster) return;
        const next = renameInRoster(roster, from, to);
        if (next !== roster) meta[ROSTER_KEY] = next;
    }

    const stopSaves = saver.onSaved((ok, key, carried) => {
        if (!ok || host.activeConversation()?.key !== key) return;
        const remaining = settledReveals(readRoster(storedRosterOf(carried)).roster,
            readRevealPairs(settings.get()), key);
        if (remaining) settings.update({ scene_join_reveals: remaining.length ? remaining : null });
    });

    return {
        gate,
        check,
        joinTime,
        forgetJoin,
        rename,
        reset() { cursor = undefined; },
        destroy() { stopSaves(); },
    };
}
