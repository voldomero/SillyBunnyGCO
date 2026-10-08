// Siblings load with this module's asset token, as groupUtils.js does, so a GCO update never mixes cached files.
const sibling = path => {
    const url = new URL(path, import.meta.url);
    const token = new URL(import.meta.url).searchParams.get('v') ?? globalThis.window?.SillyBunnyGroupUtilities?.assetToken;
    if (token) url.searchParams.set('v', token);
    return url.href;
};
const [
    { isOmniscient: omniscientIn, memoryActive, memoryOn, omniscientPatch },
    {
        HIDE_TYPES, RECORD_KEY, authorOf, blankItems, computeAway, countHidden, planHidden, readRecord, resolveChange,
        revealWalk, seedFrom, stripRecord, writeRecord,
    },
    { timeOf: readTime },
    { createChatSaver, isEmptySlot },
    { createJoinTracker },
    { SCENE_TEXT },
    { detectPresence },
    { normalizeRuleConfig },
] = await Promise.all([
    import(sibling('./settings.js')),
    import(sibling('./scene-history.js')),
    import(sibling('./scene-roster.js')),
    import(sibling('./scene-saves.js')),
    import(sibling('./scene-joins.js')),
    import(sibling('./scene-text.js')),
    import(sibling('./presence-lines.js')),
    import(sibling('./reply-rules.js')),
]);

const PREVIEW_LINES = 5;
const EXCERPT_LENGTH = 60;
const FILTER_FAILED = '[Group Utilities] Scene memory could not plan hidden lines; nothing is hidden.';
const PREVIEW_FAILED = '[Group Utilities] Scene memory could not count hidden lines for the preview.';
const EVENT_FAILED = '[Group Utilities] Scene memory could not handle a chat event.';
const SAVE_FAILED = '[Group Utilities] Scene memory could not save the chat.';
const DETECT_FAILED = '[Group Utilities] Scene memory could not read presence from a line; nothing changed.';
const CHANGES_FAILED = '[Group Utilities] Scene memory could not list presence changes.';

const HOST_EVENTS = ['CHAT_CHANGED', 'GROUP_UPDATED', 'GENERATION_STARTED', 'GROUP_WRAPPER_STARTED',
    'GROUP_WRAPPER_FINISHED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED',
    'MESSAGE_EDITED', 'MESSAGE_DELETED', 'CHARACTER_RENAMED_IN_PAST_CHAT'];
// The host saves the chat right after a reply of these types (script.js:6759, 9152).
const HOST_SAVED = new Set(['normal', 'swipe', 'continue', 'append', 'appendFinal']);
const CONTINUED = new Set(['continue', 'append', 'appendFinal']);
const UNRECORDED = new Set(['quiet', 'impersonate']);
const SWEEP_TYPES = new Set(['normal', 'swipe', 'continue']);
// New lines whose text is read for arrivals and departures (§4); greetings and other types only get a note.
const DETECTED = new Set(['normal', 'swipe', 'command']);
const SAVE_RANK = { defer: 1, idle: 2, await: 3 };

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAvatar = value => typeof value === 'string' && value.length > 0;
const lengthOf = value => Array.isArray(value) ? value.length : 0;
const strongest = (...intents) => intents.reduce((best, intent) =>
    (SAVE_RANK[intent] ?? 0) > (SAVE_RANK[best] ?? 0) ? intent : best, null);
const versionOf = message => Number.isInteger(message.swipe_id) && message.swipe_id >= 0 ? message.swipe_id : 0;
const versionCount = message => Math.max(lengthOf(message.swipes), lengthOf(message.swipe_info), 1);
const noteIn = target => isRecord(target) && isRecord(target.extra) && Object.hasOwn(target.extra, RECORD_KEY)
    ? target.extra[RECORD_KEY] : undefined;
const recordable = message => isRecord(message) && !message.is_system;
const kindOf = message => message.is_user ? 'user'
    : isRecord(message.extra) && message.extra.type === 'narrator' ? 'narrator' : 'character';
const absentIn = status => [...status].filter(([, value]) => value === 'absent').map(([avatar]) => avatar);
const statusesOf = snapshot => new Map(snapshot.participants.map(member => [member.avatar, member.status]));
const blankRecord = () => ({ away: [], moved: [], undone: [] });
// Undo attempts report '' when they took a change back, else why not.
const UNDO_DONE = Object.freeze({ reason: '', wrote: false });
const UNDO_GONE = Object.freeze({ reason: 'gone', wrote: false });
const UNDO_OFF = Object.freeze({ reason: 'off', wrote: false });

/** A change id from getChanges: [line serial, version, avatar, direction]; null when malformed. */
function parseChangeId(id) {
    let parts;
    try {
        parts = typeof id === 'string' ? JSON.parse(id) : null;
    } catch {
        return null;
    }
    if (!Array.isArray(parts) || parts.length !== 4) return null;
    const [serial, version, avatar, to] = parts;
    return Number.isInteger(serial) && Number.isInteger(version) && isAvatar(avatar) && (to === 'present' || to === 'absent')
        ? { serial, version, avatar, to } : null;
}

// The entry writeRecord mirrors into.
function mirrorOf(message) {
    const { swipe_info: entries, swipe_id: swipeId } = message;
    return Array.isArray(entries) && Number.isInteger(swipeId) && swipeId >= 0 ? entries[swipeId] : undefined;
}

/** Write a note on a line and its shown entry; true when either stored note changed. */
function writeNote(message, rec) {
    const stored = () => JSON.stringify([noteIn(message), noteIn(mirrorOf(message))]);
    const before = stored();
    writeRecord(message, rec);
    return stored() !== before;
}

// Counted in code points, so an emoji at the cut is kept whole.
const excerptOf = mes => typeof mes === 'string'
    ? Array.from(mes.replace(/\s+/g, ' ').trim()).slice(0, EXCERPT_LENGTH).join('') : '';

// A thrown value need not convert to a string (Object.create(null) cannot), and the filter must never throw.
function messageOf(error) {
    try {
        return String(error?.message || error) || 'unknown error';
    } catch {
        return 'unknown error';
    }
}

// host.timeOf rebuilds the whole host context for every line; reading the parser once keeps long chats cheap (§J.6).
const lineTimes = context => {
    const parse = context.timestampToMoment;
    return value => readTime(value, parse);
};

/** The last line dated at or before a join, whichever rule keeps or hides it; null when there is none (§J.6). */
function lastLineBefore(chat, joinedAt, timeOf) {
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (recordable(message) && timeOf(message.send_date) <= joinedAt) return index;
    }
    return null;
}

/**
 * Scene memory for the open group chat: notes on new lines, automatic presence and its timing, the join check,
 * the prompt filter, preview counts and status.
 */
export function createSceneRecorder({ host, settings, scene, detect = detectPresence, now = Date.now, log = console.warn }) {
    let destroyed = false;
    let lastError = null;
    let round = null;
    // Changes waiting for the end of the round and of every hold: `queue` from lines, `planned` from the routed plan.
    let pending = null;
    let holds = 0;
    let read = new WeakMap();
    let adoptedKey;
    let serial = 0;
    const serials = new WeakMap();
    // The latest-change index (§7): each member's latest applied change in the open chat, and what views last saw of it.
    let indexed = null;
    let indexSignature;
    // Manual-change tracking (§7): the statuses last seen, members someone else moved in each chat (until a
    // reload), and the recorder's own writes.
    let tracked = null;
    let writing = 0;
    const manual = new Set();
    const markOf = (key, avatar) => JSON.stringify([key, avatar]);
    const logged = new Set();
    const listeners = new Set();
    const warnedNotes = new Set();
    const saver = createChatSaver({ host, now, log });
    const joins = createJoinTracker({ host, settings, scene, saver, now, log });
    const chatOf = () => {
        const chat = host.getContext().chat;
        return Array.isArray(chat) ? chat : [];
    };

    function notify() {
        for (const listener of [...listeners]) {
            try { listener(); } catch (error) { log('[Group Utilities] Scene memory view failed', error); }
        }
    }

    function logOnce(message, error) {
        if (logged.has(message)) return;
        logged.add(message);
        log(message, error);
    }

    function setLastError(value) {
        if (lastError === value) return;
        lastError = value;
        notify();
    }

    /** Why both hiding rules are off for this avatar, or null when they apply (§8, §J.6). */
    function skipReason(avatar) {
        if (destroyed || !isAvatar(avatar) || !host.activeConversation() || !memoryOn(settings.get())) return 'off';
        if (!host.ignoreSymbol()) return 'unavailable';
        if (host.historyCompetitor()) return 'vocalia';
        if (omniscientIn(settings.get(), avatar)) return 'omniscient';
        return null;
    }

    /** First step of the prompt interceptor: synchronous, never throws, and leaves the items untouched on error. */
    function filter(items, type, speaker) {
        try {
            if (!HIDE_TYPES.has(type) || skipReason(speaker)) return 0;
            // joinTime is undefined whenever the join check's gate fails, which turns off the join rule only.
            const plan = planHidden(items, { speaker, type, joinTime: joins.joinTime(speaker),
                timeOf: lineTimes(host.getContext()) });
            const hidden = blankItems(items, plan, host.ignoreSymbol());
            setLastError(null);
            return hidden;
        } catch (error) {
            logOnce(FILTER_FAILED, error);
            setLastError(messageOf(error));
            return 0;
        }
    }

    function hiddenFor(avatar) {
        const none = skipped => ({ away: 0, joined: 0, lines: [], skipped });
        try {
            const skipped = skipReason(avatar);
            if (skipped) return none(skipped);
            const context = host.getContext();
            const chat = context.chat;
            const counts = countHidden(chat, { speaker: avatar, joinTime: joins.joinTime(avatar),
                timeOf: lineTimes(context) });
            const lines = counts.lines.slice(-PREVIEW_LINES).reverse()
                .map(({ index, rule }) => ({ index, rule, excerpt: excerptOf(chat[index].mes) }));
            return { away: counts.away, joined: counts.joined, lines, skipped: null };
        } catch (error) {
            logOnce(PREVIEW_FAILED, error);
            return none('unavailable');
        }
    }

    function status() {
        const capable = host.memoryCapabilities();
        const config = settings.get();
        const history = capable.history && memoryOn(config);
        return {
            capable,
            history,
            automatic: detecting(),
            steppedAside: history && host.historyCompetitor(),
            lastError,
        };
    }

    function setOmniscient(avatar, on) {
        if (!isAvatar(avatar) || omniscientIn(settings.get(), avatar) === Boolean(on)) return;
        settings.update(omniscientPatch(settings.get(), avatar, Boolean(on)));
    }

    /** The open chat's scene while new lines get notes (§4), else null. */
    function liveScene() {
        if (destroyed || !memoryOn(settings.get()) || !host.ignoreSymbol() || !host.activeConversation()) return null;
        const snapshot = scene.getSnapshot();
        return snapshot.supported === true && snapshot.key ? snapshot : null;
    }

    const isRead = message => read.get(message)?.has(versionOf(message)) === true;

    /** Automatic presence: on top of active scene memory, on hosts with the group wrapper events (§5). */
    function detecting() {
        const config = settings.get();
        return !destroyed && config.scene_auto === true && memoryActive(config) && host.memoryCapabilities().automatic;
    }

    /** Arrivals and departures a text reports for the scene's members; a detector error reads as none (§13). */
    function detectIn(text, live, { kind, author }) {
        if (typeof text !== 'string' || !detecting()) return [];
        try {
            const { characters } = normalizeRuleConfig(settings.get().reply_rules);
            const members = live.participants.map(({ avatar, name }) => ({ avatar, name,
                aliases: Object.hasOwn(characters, avatar) ? characters[avatar].aliases : [] }));
            const persona = host.getContext().name1;
            const found = detect(text, { members, persona: typeof persona === 'string' ? persona : '', author, kind });
            return Array.isArray(found) ? found : [];
        } catch (error) {
            logOnce(DETECT_FAILED, error);
            return [];
        }
    }

    const detectLine = (message, live) => detectIn(message.mes, live, { kind: kindOf(message), author: authorOf(message) });
    const deferring = () => round !== null || holds > 0;
    const queueOf = live => pending?.key === live.key ? pending.queue : [];
    const statusNow = avatar => statusesOf(scene.getSnapshot()).get(avatar);

    // `undone`: members whose planned change was undone before the user's line carried it.
    function batchFor(key) {
        if (pending?.key !== key) pending = { key, queue: [], planned: [], undone: [] };
        return pending;
    }

    /** Every live change the recorder makes goes through here, so manual-change tracking can tell it apart. */
    function setLive(avatar, status, key) {
        writing++;
        let result;
        try {
            result = scene.setState(avatar, status, key);
        } finally {
            writing--;
        }
        if (result.ok) manual.delete(markOf(key, avatar));
        return result;
    }

    /** Scene notifications: a status the recorder did not set marks that member as changed by hand (§7). */
    function track() {
        if (destroyed) return;
        // The scene panel notifies on every keystroke; with scene memory off nothing reads these marks.
        if (!memoryOn(settings.get())) {
            tracked = undefined;
            return;
        }
        try {
            const snapshot = scene.getSnapshot();
            const status = statusesOf(snapshot);
            // Another chat's statuses are no baseline for this one.
            if (tracked?.key === snapshot.key && !writing) {
                for (const [avatar, value] of status) {
                    if (tracked.status.has(avatar) && tracked.status.get(avatar) !== value) {
                        manual.add(markOf(snapshot.key, avatar));
                    }
                }
            }
            tracked = { key: snapshot.key, status };
        } catch (error) {
            logOnce(EVENT_FAILED, error);
        }
    }

    /**
     * Each member's status before the next line: the live scene with queued changes applied in order (§6), and
     * for each member the queued change that set it. A queued restore (Undo or a take-back) applies where the
     * status is still the one it undoes.
     */
    function overlayOf(live) {
        const status = statusesOf(live);
        const latest = new Map();
        for (const change of queueOf(live)) {
            const { avatar, from, to } = change;
            if (!status.has(avatar)) continue;
            if (change.restore) {
                if (status.get(avatar) !== from) continue;
                status.set(avatar, to);
                latest.delete(avatar);
                continue;
            }
            if (!resolveChange(status.get(avatar), to)) continue;
            status.set(avatar, to);
            latest.set(avatar, change);
        }
        return { status, latest };
    }

    /**
     * Apply changes in order where each member's live status still allows it. Each applied batch shows one toast
     * whose Undo takes the whole batch back; restores apply silently where the status is still the one they undo.
     */
    function apply(changes, key) {
        const status = statusesOf(scene.getSnapshot());
        const done = [];
        for (const change of changes) {
            const { avatar, from, to } = change;
            if (change.restore) {
                if (status.get(avatar) === from && setLive(avatar, to, key).ok) status.set(avatar, to);
                continue;
            }
            const allowed = status.has(avatar) && resolveChange(status.get(avatar), to);
            if (!allowed || !setLive(avatar, to, key).ok) continue;
            status.set(avatar, to);
            done.push({ change, from: allowed.from });
        }
        if (done.length) {
            host.toast({ level: 'info', text: SCENE_TEXT.P11, actionLabel: SCENE_TEXT.P12,
                onAction: () => undoChanges(done.map(({ change }) => change)) });
        }
        return done;
    }

    /**
     * Put a member back to `target` where the live status is still `expect`: now, or at the drain (§6, §7). What
     * it takes back came before every queued change, so it waits ahead of that member's first one.
     */
    function restoreLive(avatar, expect, target, key) {
        if (deferring()) {
            const { queue } = batchFor(key);
            const at = queue.findIndex(change => !change.restore && change.avatar === avatar);
            queue.splice(at < 0 ? queue.length : at, 0, { restore: true, avatar, from: expect, to: target });
            return true;
        }
        return statusNow(avatar) === expect && setLive(avatar, target, key).ok;
    }

    /**
     * Inside a round or while something holds the scene, changes wait for the drain; otherwise they apply now (§6).
     * A queued change keeps `prior`, the queued change it follows for that member, and `hid`, the lines noted
     * against it while it made the member absent.
     */
    function settle(message, made, live, latest) {
        if (!made.length) return;
        const changes = made.map(([avatar, from, to]) => ({ avatar, from, to, message, version: versionOf(message),
            prior: latest.get(avatar) ?? null, hid: [] }));
        if (!deferring()) {
            apply(changes, live.key);
            return;
        }
        batchFor(live.key).queue.push(...changes);
        notify();
    }

    /** A member's status just before a queued change, counting only the queued changes before it that applied. */
    function statusBefore(change, dropped) {
        let first = change;
        while (first.prior && dropped.has(first.prior)) first = first.prior;
        return first.prior ? first.prior.to : first.from;
    }

    /**
     * Queued changes that will never apply: each leaves its line's `moved` while that version is shown, and a
     * departure leaves the `away` of the lines noted against it unless the member was absent anyway, so a change
     * that did not happen hides nothing. True when a note changed.
     */
    function discard(changes) {
        const chat = new Set(chatOf());
        const dropped = new Set(changes);
        const recordOn = ({ message, version }) => chat.has(message) && versionOf(message) === version
            ? readRecord(message.extra).record : null;
        let wrote = false;
        for (const change of changes) {
            if (change.restore) continue;
            const { avatar, to, message, hid } = change;
            const own = recordOn(change);
            const moved = own?.moved.filter(([mover, , result]) => mover !== avatar || result !== to);
            if (moved && moved.length < own.moved.length) wrote = writeNote(message, { ...own, moved }) || wrote;
            if (to !== 'absent' || statusBefore(change, dropped) === 'absent') continue;
            for (const line of hid) {
                const record = recordOn(line);
                if (!record?.away.includes(avatar)) continue;
                wrote = writeNote(line.message, { ...record, away: record.away.filter(name => name !== avatar) }) || wrote;
            }
        }
        return wrote;
    }

    // A note rewritten after its line was saved: the round end saves it, or GCO does once the host is idle.
    function persistLater() {
        if (round || host.isGenerating() === true) saver.markUnsaved();
        else saver.save().catch(error => logOnce(SAVE_FAILED, error));
    }

    function markRead(message, versions = [versionOf(message)]) {
        const seen = read.get(message) ?? new Set();
        for (const version of versions) seen.add(version);
        read.set(message, seen);
    }

    function warnNote() {
        const key = host.activeConversation()?.key;
        if (!key || warnedNotes.has(key)) return;
        warnedNotes.add(key);
        host.toast({ level: 'warning', text: SCENE_TEXT.P15 });
    }

    /** Every version now in the chat counts as read: loaded history, and lines written while scene memory was off. */
    function readAll(live) {
        let invalid = false;
        for (const message of chatOf()) {
            if (!isRecord(message)) continue;
            markRead(message, [...Array(versionCount(message)).keys(), versionOf(message)]);
            if (live && !invalid) invalid = readRecord(message.extra).invalid;
        }
        if (invalid) warnNote();
    }

    /** The join toast's newcomers: each one's scene name and how many earlier lines the join hides from them. */
    function joinDetail(avatars) {
        try {
            const context = host.getContext();
            const timeOf = lineTimes(context);
            const names = new Map(scene.getSnapshot().participants.map(member => [member.avatar, member.name]));
            return avatars.map(avatar => {
                const { joined } = countHidden(context.chat, { speaker: avatar, joinTime: joins.joinTime(avatar), timeOf });
                return `${names.get(avatar) ?? avatar} (${joined})`;
            }).join(', ');
        } catch (error) {
            logOnce(PREVIEW_FAILED, error);
            return undefined;
        }
    }

    /** The join check, with its roster warning and its newcomers shown (§J.8); returns the save it asks for. */
    function checkJoins(trigger, details) {
        const { save, warning, announce } = joins.check(trigger, details);
        if (warning === 'invalid' || warning === 'foreign') {
            host.toast({ level: 'warning', text: warning === 'invalid' ? SCENE_TEXT.P27 : SCENE_TEXT.P28 });
        }
        if (announce.length) {
            const key = host.activeConversation()?.key;
            host.toast({ level: 'info', text: SCENE_TEXT.P25, detail: joinDetail(announce), actionLabel: SCENE_TEXT.P12,
                onAction: () => forgetJoins(announce, key) });
        }
        return save;
    }

    const fresh = (message, absentAt) => ({
        away: computeAway({ absentAt, movers: [], author: authorOf(message) }), moved: [], undone: [],
    });

    /** Store a note for the shown version, mark it read and remember it for the round's copy stripping. */
    function noteLine(message, rec, target = round) {
        const changed = writeNote(message, rec);
        markRead(message);
        if (target) {
            const versions = target.recorded.get(message) ?? new Set();
            versions.add(versionOf(message));
            target.recorded.set(message, versions);
        }
        return changed;
    }

    /**
     * Note a new line or version against the overlay (§4): the planned changes it carries, then those its text
     * makes when `detected`, except for members whose planned change was undone. Its own changes apply now or
     * wait for the drain.
     */
    function noteFresh(message, live, { detected = true, planned = [], undone = [], target = round } = {}) {
        const { status, latest } = overlayOf(live);
        const moved = planned.map(({ avatar, from, to }) => [avatar, from, to]);
        for (const { avatar, to } of detected ? detectLine(message, live) : []) {
            if (!status.has(avatar) || undone.includes(avatar) || moved.some(([mover]) => mover === avatar)) continue;
            const change = resolveChange(status.get(avatar), to);
            if (change) moved.push([avatar, change.from, change.to]);
        }
        const away = computeAway({ absentAt: absentIn(status), movers: moved.map(([avatar]) => avatar),
            author: authorOf(message) });
        const changed = noteLine(message, { away, moved, undone }, target);
        for (const avatar of away) {
            const hider = latest.get(avatar);
            if (hider?.to === 'absent') hider.hid.push({ message, version: versionOf(message) });
        }
        settle(message, moved.slice(planned.length), live, latest);
        return changed;
    }

    /** A line GCO has not read: appended, it is read in full; inserted, it copies its neighbour's after-state (§4). */
    function recordNew(index, live, options) {
        const chat = chatOf();
        const message = chat[index];
        if (!recordable(message) || isRead(message)) return false;
        if (index < chat.length - 1) return noteLine(message, fresh(message, seedFrom(chat.slice(0, index)) ?? []));
        return noteFresh(message, live, options);
    }

    /**
     * Continue rules: the full text is read again and only changes the line does not list in `moved` or `undone`
     * are added; its away list can only shrink. An unread line is a new one.
     */
    function recordContinued(message, live, target = round) {
        if (!recordable(message)) return false;
        if (!isRead(message)) return noteFresh(message, live, { target });
        const { record, invalid } = readRecord(message.extra);
        if (invalid) {
            warnNote();
            return false;
        }
        const base = record ?? { away: [], moved: [], undone: [] };
        const { status, latest } = overlayOf(live);
        const moved = [...base.moved];
        for (const { avatar, to } of detectLine(message, live)) {
            if (!status.has(avatar) || base.undone.includes(avatar)
                || moved.some(([mover, , result]) => mover === avatar && result === to)) continue;
            const change = resolveChange(status.get(avatar), to);
            if (change) moved.push([avatar, change.from, change.to]);
        }
        const seen = computeAway({ absentAt: absentIn(status), movers: moved.map(([avatar]) => avatar),
            author: authorOf(message) });
        const away = base.away.filter(avatar => seen.includes(avatar));
        if (moved.length === base.moved.length && away.length === base.away.length) return false;
        const changed = noteLine(message, { ...base, away, moved }, target);
        settle(message, moved.slice(base.moved.length), live, latest);
        return changed;
    }

    // A line the host saved just before the event (or reloads from disk after an insert) needs GCO's own save.
    function createdSave(inserted) {
        return inserted || host.isGenerating() !== true ? 'await' : 'defer';
    }

    function receivedSave(type, inserted) {
        if (type === 'command') return createdSave(inserted);
        if (type === 'first_message') return 'await';
        // Without isGenerating the host's own save cannot be relied on (§13).
        return HOST_SAVED.has(type) && typeof host.isGenerating() === 'boolean' ? null : 'idle';
    }

    async function persist(intent) {
        if (intent === 'await') await saver.save();
        else if (intent === 'idle' && host.isGenerating() !== true) saver.save().catch(error => logOnce(SAVE_FAILED, error));
        else if (intent) saver.markUnsaved();
    }

    // The host emits message events only in a loaded chat, and saves that same header around them (§J.4).
    function adopt() {
        const key = host.activeConversation()?.key;
        if (!key || key === adoptedKey) return;
        adoptedKey = key;
        saver.adopt();
    }

    /**
     * A branch, import or renamed chat has no scene entry of its own yet: the members absent after its newest
     * recorded line start absent, with Undo (§3). The join roster plays no part.
     */
    function seed(live) {
        const chats = settings.get().current_scenes?.chats;
        if (!live || (isRecord(chats) && Object.hasOwn(chats, live.key))) return;
        const before = statusesOf(live);
        const seeded = [];
        for (const avatar of seedFrom(chatOf()) ?? []) {
            if (!before.has(avatar) || before.get(avatar) === 'absent') continue;
            if (setLive(avatar, 'absent', live.key).ok) seeded.push([avatar, before.get(avatar)]);
        }
        if (!seeded.length) return;
        host.toast({ level: 'info', text: SCENE_TEXT.P13, actionLabel: SCENE_TEXT.P12,
            onAction: () => undoBatch(seeded.map(([avatar, status]) => () => liveScene()?.key === live.key
                && restoreLive(avatar, 'absent', status, live.key) ? UNDO_DONE : UNDO_GONE)) });
    }

    // setState refuses a stale key, so what waits for the old chat is dropped (§12).
    function chatChanged() {
        checkJoins('CHAT_CHANGED');
        const dropped = pending !== null;
        round = null;
        pending = null;
        saver.reset();
        setLastError(null);
        read = new WeakMap();
        indexed = null;
        track();
        const live = liveScene();
        // Turning scene memory on reads the history then, so a chat opened while it is off skips the scan.
        if (memoryOn(settings.get())) readAll(live);
        seed(live);
        if (dropped) notify();
    }

    async function messageSent(id) {
        adopt();
        const intent = checkJoins('MESSAGE_SENT', { id });
        const live = liveScene();
        const index = Number(id);
        const chat = chatOf();
        const message = chat[index];
        const inserted = index < chat.length - 1;
        let wrote = false;
        if (live) {
            // The routed plan's changes belong to the user's line it planned for (§6).
            const carries = !inserted && recordable(message) && message.is_user && !isRead(message)
                && pending?.key === live.key;
            const planned = carries ? pending.planned.splice(0) : [];
            // A toast's Undo finds a planned change on the line that carries it from now on.
            for (const change of planned) Object.assign(change, { message, version: versionOf(message) });
            wrote = recordNew(index, live, { planned, undone: carries ? pending.undone.splice(0) : [] });
        }
        await persist(strongest(intent, wrote ? createdSave(inserted) : null));
    }

    async function messageReceived(id, type) {
        adopt();
        const intent = checkJoins('MESSAGE_RECEIVED', { id, type });
        const live = liveScene();
        const index = Number(id);
        const chat = chatOf();
        const message = chat[index];
        let wrote = false;
        if (live && !UNRECORDED.has(type)) {
            if (CONTINUED.has(type)) {
                if (round) round.continued = true;
                wrote = recordContinued(message, live);
            } else if (type === 'first_message') {
                // The greeting is in the file before CHAT_CHANGED, so it is already marked read.
                wrote = recordable(message) && noteFresh(message, live, { detected: false });
            } else wrote = recordNew(index, live, { detected: DETECTED.has(type) });
        }
        let save = strongest(intent, wrote ? receivedSave(type, index < chat.length - 1) : null);
        if (HOST_SAVED.has(type)) {
            // The host's save right after this event carries every change made so far.
            saver.clearUnsaved();
            if (save !== 'await' && host.isGenerating() === true) save = null;
        }
        await persist(save);
    }

    /** A read version shown again on the newest line: its stored changes apply where the live status allows (§4). */
    function reapply(message, live) {
        const { record } = readRecord(message.extra);
        if (record?.moved.length && detecting()) settle(message, record.moved, live, new Map());
    }

    function messageSwiped(id) {
        // The old version's change is taken back first, so the version now shown meets the scene without it.
        withdraw();
        const live = liveScene();
        const chat = chatOf();
        const index = Number(id);
        const message = chat[index];
        if (!live || !isRecord(message)) return;
        // The new slot's `extra` is the old version's, and its index may be one a removed version had.
        if (isEmptySlot(message)) {
            stripRecord(message);
            read.get(message)?.delete(versionOf(message));
            return;
        }
        if (index !== chat.length - 1 || !recordable(message)) return;
        // n>1 alternatives and /swipes-add versions are read when first shown on the newest line.
        if (isRead(message)) reapply(message, live);
        else noteFresh(message, live);
    }

    /** deleteSwipe renumbers the versions above the deleted one (script.js:15448-15466). */
    function swipeDeleted(details) {
        if (!isRecord(details)) return;
        const { messageId, swipeId } = details;
        const message = chatOf()[Number(messageId)];
        if (!isRecord(message) || !Number.isInteger(swipeId) || swipeId < 0) return;
        const renumber = version => version > swipeId ? version - 1 : version;
        const seen = read.get(message);
        if (seen) read.set(message, new Set([...seen].filter(version => version !== swipeId).map(renumber)));
        // A change on the deleted version no longer counts as shown, so the swipe that follows takes it back.
        for (const ref of indexed?.latest.values() ?? []) {
            if (ref.message === message) ref.version = ref.version === swipeId ? -1 : renumber(ref.version);
        }
    }

    /**
     * Edit rules (§4): changes the text no longer makes leave the note and are taken back if latest; on the
     * newest line only, changes it now makes are added. The host saves right after the event.
     */
    function messageEdited(id) {
        const live = liveScene();
        const chat = chatOf();
        const index = Number(id);
        const message = chat[index];
        const editable = live !== null && detecting() && recordable(message) && isRead(message);
        const { record, invalid } = editable ? readRecord(message.extra) : { record: null, invalid: false };
        if (invalid) warnNote();
        const base = record ?? blankRecord();
        const found = editable && !invalid ? detectLine(message, live) : [];
        const makes = (avatar, to) => found.some(change => change.avatar === avatar && change.to === to);
        const moved = base.moved.filter(([avatar, , to]) => makes(avatar, to));
        if (moved.length < base.moved.length) {
            writeNote(message, { ...base, moved });
            notify();
        }
        withdraw();
        // Read against the scene after the take-back above, as a Continue reads its line.
        const current = liveScene();
        if (!found.length || index !== chat.length - 1 || !current) return;
        const { status, latest } = overlayOf(current);
        const added = [];
        for (const { avatar, to } of found) {
            if (!status.has(avatar) || base.undone.includes(avatar)
                || moved.some(([mover, , result]) => mover === avatar && result === to)) continue;
            const change = resolveChange(status.get(avatar), to);
            if (change) added.push([avatar, change.from, change.to]);
        }
        if (!added.length) return;
        const movers = new Set(added.map(([avatar]) => avatar));
        writeNote(message, { ...base, away: base.away.filter(avatar => !movers.has(avatar)), moved: [...moved, ...added] });
        settle(message, added, current, latest);
    }

    /** The sweep and copy stripping need the chat as it was at the start; that is read only while `recording`. */
    function newRound(key, type, started, recording = true) {
        const state = { key, type, started, recording, recorded: new Map(), continued: false };
        if (!recording) return state;
        const chat = chatOf();
        const last = chat[chat.length - 1];
        const entries = new WeakMap();
        for (const message of chat) if (isRecord(message)) entries.set(message, lengthOf(message.swipe_info));
        return {
            ...state,
            startLength: chat.length,
            last: isRecord(last) ? { message: last, versions: versionCount(last), text: last.mes } : null,
            entries,
        };
    }

    // Rounds are tracked while scene memory is off too, so changes found after it turns on still wait (§6).
    function startRound(info) {
        const live = liveScene();
        const key = live?.key ?? host.activeConversation()?.key;
        // A round the routed plan began is replaced; its planned changes wait in `pending`, not here.
        round = key ? newRound(key, typeof info?.type === 'string' && info.type ? info.type : 'normal', true, Boolean(live))
            : null;
    }

    /**
     * The routed plan's hook (§6): runs before the plan captures members and the scene, so the composer text's
     * changes apply at once and wait as `planned` for the user's line. It starts the round.
     */
    function prepareTurn({ text, key } = {}) {
        try {
            const live = liveScene();
            if (!live || live.key !== key || typeof text !== 'string' || !detecting()) return;
            round ??= newRound(live.key, 'normal', false);
            const done = apply(detectIn(text, live, { kind: 'user' }).map(({ avatar, to }) => ({ avatar, to })), key);
            // The toast's Undo holds these same objects, so it finds them on the user's line once it is sent.
            batchFor(key).planned.push(...done.map(({ change, from }) => Object.assign(change, { from })));
        } catch (error) {
            logOnce(EVENT_FAILED, error);
        }
    }

    /** True while a queued change's line still shows the version that recorded it, and its note still lists it. */
    function stillListed({ message, version, avatar, to }) {
        if (versionOf(message) !== version || !chatOf().includes(message)) return false;
        return readRecord(message.extra).record?.moved.some(([mover, , result]) => mover === avatar && result === to) === true;
    }

    /**
     * After the round and every hold: planned changes no line carried go back, then queued ones apply (§6); the
     * rest are discarded. Queued restores from Undo and take-backs apply with automatic presence off too. True
     * when a note changed.
     */
    function drain() {
        if (round || holds > 0 || !pending) return false;
        const batch = pending;
        pending = null;
        let wrote = false;
        try {
            const live = liveScene();
            const automatic = detecting();
            let dropped = batch.queue.filter(change => !change.restore);
            if (live?.key === batch.key) {
                for (const { avatar, from, to } of automatic ? batch.planned : []) {
                    if (statusNow(avatar) === to) setLive(avatar, from, batch.key);
                }
                const due = batch.queue.filter(change => change.restore || (automatic && stillListed(change)));
                const done = new Set(apply(due, batch.key).map(({ change }) => change));
                dropped = dropped.filter(change => !done.has(change));
            }
            wrote = discard(dropped);
        } catch (error) {
            logOnce(EVENT_FAILED, error);
        }
        notify();
        return wrote;
    }

    /** Keeps scene changes waiting until the returned release; an Ask holds the scene until it settles (§6). */
    function hold() {
        if (destroyed) return () => {};
        holds++;
        let held = true;
        return () => {
            if (!held) return;
            held = false;
            holds--;
            if (drain()) persistLater();
            reindex();
        };
    }

    /** Lines a round wrote without MESSAGE_RECEIVED, such as a stopped stream (script.js:6798-6806). */
    function sweep(ended, live) {
        const chat = chatOf();
        let wrote = false;
        for (let index = ended.startLength; index < chat.length; index++) {
            const message = chat[index];
            if (recordable(message) && !message.is_user && !isRead(message)) {
                wrote = noteFresh(message, live, { target: ended }) || wrote;
            }
        }
        const newest = chat[chat.length - 1];
        if (!recordable(newest)) return wrote;
        // A swipe that got no reply still shows its empty slot here; the host puts the old version back after the round.
        if (ended.type === 'swipe' && !isEmptySlot(newest) && !isRead(newest)) {
            wrote = noteFresh(newest, live, { target: ended }) || wrote;
        }
        if (ended.type === 'continue' && !ended.continued && newest === ended.last?.message && newest.mes !== ended.last.text) {
            wrote = recordContinued(newest, live, ended) || wrote;
        }
        return wrote;
    }

    /** n>1 alternatives copy the recorded `extra`; only the recorded version and older entries keep a note. */
    function stripCopies(ended) {
        let stripped = false;
        for (const [message, versions] of ended.recorded) {
            const entries = Array.isArray(message.swipe_info) ? message.swipe_info : [];
            for (let index = ended.entries.get(message) ?? 0; index < entries.length; index++) {
                if (versions.has(index) || noteIn(entries[index]) === undefined) continue;
                stripRecord(entries[index]);
                stripped = true;
            }
        }
        return stripped;
    }

    // Quiet and impersonate rounds write no reply and the wrapper never saves when it ends (group-chats.js:1812-1826).
    async function finishRound() {
        const ended = round;
        try {
            const live = liveScene();
            if (ended?.started && ended.recording && live && ended.key === live.key && SWEEP_TYPES.has(ended.type)) {
                // The round is still open here, so what the sweep reads waits for the drain below.
                const swept = sweep(ended, live);
                if (stripCopies(ended) || swept) saver.markUnsaved();
            }
        } finally {
            round = null;
            const drained = drain();
            if (withdraw() || drained) saver.markUnsaved();
            await saver.flush();
        }
    }

    // A change is named by its line object, which outlives the index shifts of deletes and inserts, and by its
    // direction: a line version moves a member at most once each way.
    function serialOf(message) {
        if (!serials.has(message)) serials.set(message, ++serial);
        return serials.get(message);
    }

    const changeId = (message, avatar, to) => JSON.stringify([serialOf(message), versionOf(message), avatar, to]);

    /**
     * Lines whose shown version moves someone, in chat order, hidden lines included; each member's latest applied
     * change (§7); and whether a listed change still waits in the queue.
     */
    function scanChanges(live) {
        const queue = queueOf(live).filter(change => !change.restore);
        const isQueued = (message, [avatar, , to]) => queue.some(change => change.message === message
            && change.avatar === avatar && change.to === to && change.version === versionOf(message));
        const lines = [];
        const latest = new Map();
        for (const [index, message] of chatOf().entries()) {
            const moved = isRecord(message) ? readRecord(message.extra).record?.moved : undefined;
            if (!moved?.length) continue;
            lines.push({ index, message, moved });
            for (const entry of moved) {
                if (!isQueued(message, entry)) latest.set(entry[0], { index, message, version: versionOf(message), entry });
            }
        }
        return { lines, latest, isQueued };
    }

    /** Each member's latest applied change and every queued one, in chat order, for the changes list. */
    function getChanges() {
        try {
            const live = liveScene();
            if (!live) return [];
            const { lines, latest, isQueued } = scanChanges(live);
            const names = new Map(live.participants.map(member => [member.avatar, member.name]));
            return lines.flatMap(({ index, message, moved }) => moved.flatMap(entry => {
                const isPending = isQueued(message, entry);
                if (!isPending && latest.get(entry[0])?.entry !== entry) return [];
                const [avatar, from, to] = entry;
                return [{ id: changeId(message, avatar, to), avatar, name: names.get(avatar) ?? avatar, from, to, index,
                    excerpt: excerptOf(message.mes), pending: isPending }];
            }));
        } catch (error) {
            logOnce(CHANGES_FAILED, error);
            return [];
        }
    }

    /** Rebuild the latest-change index from the notes (§3, §7); views hear when the changes list moved. */
    function reindex() {
        try {
            const live = liveScene();
            const latest = live ? scanChanges(live).latest : new Map();
            indexed = live ? { key: live.key, latest } : null;
            const signature = JSON.stringify([live?.key, ...[...latest].map(([avatar, { index, message, entry }]) =>
                [index, changeId(message, avatar, entry[2]), entry[1], excerptOf(message.mes)])]);
            if (signature === indexSignature) return;
            indexSignature = signature;
            notify();
        } catch (error) {
            indexed = null;
            logOnce(CHANGES_FAILED, error);
        }
    }

    /** The reveal walk (§7): the lines a departure hid show again to that member. True when a note changed. */
    function reveal(avatar) {
        const chat = chatOf();
        let wrote = false;
        for (const index of revealWalk(chat, avatar)) {
            const { record } = readRecord(chat[index].extra);
            if (!record) continue;
            wrote = writeNote(chat[index], { ...record, away: record.away.filter(name => name !== avatar) }) || wrote;
        }
        return wrote;
    }

    /**
     * Withdrawal (§7), after a delete, edit, swipe or round end: a member's previously indexed change whose line is
     * gone, shows another version or no longer lists it goes back to `from`, where the live status is still its
     * result and nobody has moved that member by hand; a withdrawn departure reveals. True when a note changed.
     */
    function withdraw() {
        const before = indexed;
        reindex();
        const live = liveScene();
        if (!before || live?.key !== before.key || !detecting()) return false;
        let wrote = false;
        try {
            for (const [avatar, { message, version, entry: [, from, to] }] of before.latest) {
                if (stillListed({ message, version, avatar, to }) || manual.has(markOf(live.key, avatar))
                    || statusNow(avatar) !== to) continue;
                if (restoreLive(avatar, to, from, live.key) && to === 'absent') wrote = reveal(avatar) || wrote;
            }
        } catch (error) {
            logOnce(EVENT_FAILED, error);
        }
        return wrote;
    }

    /**
     * Undo one change a line lists (§7): a member's latest applied change, or one still queued. The note changes at
     * once; the live status follows now or at the drain.
     */
    function undoLine(message, version, avatar, to) {
        const live = liveScene();
        if (!live) return UNDO_OFF;
        if (!stillListed({ message, version, avatar, to })) return UNDO_GONE;
        const queue = queueOf(live);
        const queued = queue.find(change => !change.restore && change.message === message && change.version === version
            && change.avatar === avatar && change.to === to);
        if (queued) {
            queue.splice(queue.indexOf(queued), 1);
            for (const change of queue) if (change.prior === queued) change.prior = queued.prior;
            const wrote = discard([queued]);
            // A line that only listed this change has no note left.
            const after = readRecord(message.extra).record ?? blankRecord();
            return { reason: '', wrote: writeNote(message, { ...after, undone: [...after.undone, avatar] }) || wrote };
        }
        const newest = scanChanges(live).latest.get(avatar);
        if (newest?.message !== message || newest.entry[2] !== to) return { reason: 'superseded', wrote: false };
        const { record } = readRecord(message.extra);
        const at = record.moved.findIndex(([mover, , result]) => mover === avatar && result === to);
        let wrote = writeNote(message, { ...record, moved: record.moved.filter((_, index) => index !== at),
            undone: [...record.undone, avatar] });
        restoreLive(avatar, to, newest.entry[1], live.key);
        if (to === 'absent') wrote = reveal(avatar) || wrote;
        return { reason: '', wrote };
    }

    /** A routed plan's change no line carries yet: the user's line will list it as undone (§6, §7). */
    function undoPlanned(change) {
        const live = liveScene();
        if (!live) return UNDO_OFF;
        const at = pending?.key === live.key ? pending.planned.indexOf(change) : -1;
        if (at < 0) return UNDO_GONE;
        pending.planned.splice(at, 1);
        pending.undone.push(change.avatar);
        restoreLive(change.avatar, change.to, change.from, live.key);
        return UNDO_DONE;
    }

    /** One Undo press: every attempt, then one toast and one save; the first reason when nothing was taken back. */
    function undoBatch(attempts) {
        if (destroyed) return { ok: false, reason: 'off' };
        const reasons = [];
        let wrote = false;
        for (const attempt of attempts) {
            let result = UNDO_GONE;
            try {
                result = attempt();
            } catch (error) {
                logOnce(EVENT_FAILED, error);
            }
            reasons.push(result.reason);
            wrote = result.wrote || wrote;
        }
        const ok = reasons.includes('');
        host.toast(ok ? { level: 'info', text: SCENE_TEXT.P19 } : { level: 'warning', text: SCENE_TEXT.P20 });
        if (wrote) persistLater();
        reindex();
        notify();
        return { ok, reason: ok ? '' : reasons[0] ?? 'gone' };
    }

    // A toast keeps the change objects it applied: a planned one is found on the user's line once that is sent.
    const undoChanges = changes => undoBatch(changes.map(change => () => change.message
        ? undoLine(change.message, change.version, change.avatar, change.to) : undoPlanned(change)));

    /** Undo a change named by an id from getChanges (§7). */
    function undo(id) {
        return undoBatch([() => {
            if (!liveScene()) return UNDO_OFF;
            const parsed = parseChangeId(id);
            const message = parsed ? chatOf().find(line => isRecord(line) && serials.get(line) === parsed.serial) : undefined;
            return message ? undoLine(message, parsed.version, parsed.avatar, parsed.to) : UNDO_GONE;
        }]);
    }

    /** Join Undo (§J.8): the named newcomers see every earlier line of that chat, saved as a live join is (§J.4). */
    function forgetJoins(avatars, chatKey) {
        if (destroyed) return { ok: false, applied: false };
        let ok = false;
        let applied = false;
        for (const avatar of avatars) {
            const result = joins.forgetJoin(avatar, chatKey);
            ok = result.ok || ok;
            applied = result.applied || applied;
        }
        if (applied) persist('idle').catch(error => logOnce(SAVE_FAILED, error));
        host.toast(ok ? { level: 'info', text: SCENE_TEXT.P24 } : { level: 'warning', text: SCENE_TEXT.P20 });
        notify();
        return { ok, applied };
    }

    /**
     * A member's join for the scene line (§J.8): when they joined, the last line before it, how many lines the join
     * hides, and what turns join hiding off for them.
     */
    function joinStatus(avatar) {
        const none = { joinedAt: null, lastPreJoin: null, hidden: 0, off: null };
        try {
            const skipped = skipReason(avatar);
            if (skipped === 'off' || skipped === 'unavailable') return none;
            const joinedAt = joins.joinTime(avatar);
            if (!Number.isFinite(joinedAt)) return none;
            const context = host.getContext();
            const chat = Array.isArray(context.chat) ? context.chat : [];
            const timeOf = lineTimes(context);
            return { joinedAt, lastPreJoin: lastLineBefore(chat, joinedAt, timeOf),
                hidden: countHidden(chat, { speaker: avatar, joinTime: joinedAt, timeOf }).joined, off: skipped };
        } catch (error) {
            logOnce(PREVIEW_FAILED, error);
            return none;
        }
    }

    const handlers = {
        CHAT_CHANGED: chatChanged,
        GROUP_UPDATED: () => persist(checkJoins('GROUP_UPDATED')),
        GENERATION_STARTED: (type, _options, dryRun) => persist(checkJoins('GENERATION_STARTED', { type, dryRun })),
        GROUP_WRAPPER_STARTED: startRound,
        GROUP_WRAPPER_FINISHED: finishRound,
        MESSAGE_SENT: messageSent,
        MESSAGE_RECEIVED: messageReceived,
        MESSAGE_SWIPED: messageSwiped,
        MESSAGE_SWIPE_DELETED: swipeDeleted,
        MESSAGE_EDITED: messageEdited,
        // Delete mode saves before it emits (script.js:17963-17966), so notes a take-back rewrites need GCO's save.
        MESSAGE_DELETED: () => {
            saver.noteDelete();
            if (withdraw()) persistLater();
        },
        // The host awaits this event, then saves that file itself (group-chats.js:1373-1380).
        CHARACTER_RENAMED_IN_PAST_CHAT: (messages, from, to) => joins.rename(messages, from, to),
    };

    async function onHostEvent(name, ...args) {
        if (destroyed || !Object.hasOwn(handlers, name)) return;
        try {
            await handlers[name](...args);
        } catch (error) {
            logOnce(EVENT_FAILED, error);
        }
        // deleteSwipe emits before it shows the next version; that swipe must still find the old version's change.
        if (!destroyed && name !== 'MESSAGE_SWIPE_DELETED') reindex();
    }

    let active = memoryActive(settings.get());
    let automatic = detecting();
    let token = settings.get().scene_history_since;

    // A new or renewed token is a turn-on (§J.3). The check's own settings writes re-enter here as no change.
    function settingsChanged() {
        if (destroyed) return;
        try {
            const config = settings.get();
            const wasActive = active;
            const wasAutomatic = automatic;
            const renewed = config.scene_history_since !== token;
            active = memoryActive(config);
            automatic = detecting();
            token = config.scene_history_since;
            if (wasActive && !active) joins.reset();
            // Switched off mid-round: what waits is not applied and planned changes are not taken back (§6), but
            // queued ones leave the notes, so they hide nothing. Restores from Undo still apply at the drain.
            if (wasAutomatic && !automatic && pending) {
                const batch = pending;
                const restores = batch.queue.filter(change => change.restore);
                pending = restores.length ? { ...batch, queue: restores, planned: [] } : null;
                if (discard(batch.queue)) persistLater();
                notify();
            }
            if (!active || (wasActive && !renewed)) return;
            checkJoins('turn-on');
            if (wasActive) return;
            track();
            readAll(liveScene());
            reindex();
        } catch (error) {
            logOnce(EVENT_FAILED, error);
        }
    }

    const stopEvents = host.onHostEvents(HOST_EVENTS, onHostEvent);
    const stopSettings = settings.subscribe(settingsChanged);
    const stopScene = scene.subscribe(track);

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        stopEvents();
        stopSettings();
        stopScene();
        round = null;
        pending = null;
        listeners.clear();
        joins.destroy();
        saver.destroy();
    }

    // GCO can start after the chat's CHAT_CHANGED; the init check sets the cursor before the first filter.
    try {
        checkJoins('init');
        track();
        if (memoryOn(settings.get())) readAll(liveScene());
        reindex();
    } catch (error) {
        logOnce(EVENT_FAILED, error);
    }

    return {
        filter,
        hiddenFor,
        status,
        isOmniscient: avatar => omniscientIn(settings.get(), avatar),
        setOmniscient,
        prepareTurn,
        hold,
        getChanges,
        undo,
        joinStatus,
        forgetJoin: (avatar, chatKey = host.activeConversation()?.key) => forgetJoins([avatar], chatKey),
        subscribe(listener) {
            if (destroyed) return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        destroy,
    };
}
