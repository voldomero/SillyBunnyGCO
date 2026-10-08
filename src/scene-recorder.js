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
        HIDE_TYPES, RECORD_KEY, authorOf, blankItems, computeAway, countHidden, planHidden, readRecord, seedFrom,
        stripRecord, writeRecord,
    },
    { timeOf: readTime },
    { createChatSaver, isEmptySlot },
    { createJoinTracker },
    { SCENE_TEXT },
] = await Promise.all([
    import(sibling('./settings.js')),
    import(sibling('./scene-history.js')),
    import(sibling('./scene-roster.js')),
    import(sibling('./scene-saves.js')),
    import(sibling('./scene-joins.js')),
    import(sibling('./scene-text.js')),
]);

const PREVIEW_LINES = 5;
const EXCERPT_LENGTH = 60;
const FILTER_FAILED = '[Group Utilities] Scene memory could not plan hidden lines; nothing is hidden.';
const PREVIEW_FAILED = '[Group Utilities] Scene memory could not count hidden lines for the preview.';
const EVENT_FAILED = '[Group Utilities] Scene memory could not handle a chat event.';
const SAVE_FAILED = '[Group Utilities] Scene memory could not save the chat.';

const HOST_EVENTS = ['CHAT_CHANGED', 'GROUP_UPDATED', 'GENERATION_STARTED', 'GROUP_WRAPPER_STARTED',
    'GROUP_WRAPPER_FINISHED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED',
    'MESSAGE_EDITED', 'MESSAGE_DELETED', 'CHARACTER_RENAMED_IN_PAST_CHAT'];
// The host saves the chat right after a reply of these types (script.js:6759, 9152).
const HOST_SAVED = new Set(['normal', 'swipe', 'continue', 'append', 'appendFinal']);
const CONTINUED = new Set(['continue', 'append', 'appendFinal']);
const UNRECORDED = new Set(['quiet', 'impersonate']);
const SWEEP_TYPES = new Set(['normal', 'swipe', 'continue']);
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

/** Scene memory for the open group chat: notes on new lines, the join check, the prompt filter, preview counts and status. */
export function createSceneRecorder({ host, settings, scene, now = Date.now, log = console.warn }) {
    let destroyed = false;
    let lastError = null;
    let round = null;
    let read = new WeakMap();
    let adoptedKey;
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
            automatic: history && capable.automatic && config.scene_auto === true,
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

    const absentIn = live => live.participants.filter(member => member.status === 'absent').map(member => member.avatar);
    const isRead = message => read.get(message)?.has(versionOf(message)) === true;

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

    /** The join check, with its roster warning shown; returns the save it asks for. */
    function checkJoins(trigger, details) {
        const { save, warning } = joins.check(trigger, details);
        if (warning === 'invalid' || warning === 'foreign') {
            host.toast({ level: 'warning', text: warning === 'invalid' ? SCENE_TEXT.P27 : SCENE_TEXT.P28 });
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

    /** A line GCO has not read: appended, it sees the live scene; inserted, its neighbour's after-state (§4). */
    function recordNew(index, live) {
        const chat = chatOf();
        const message = chat[index];
        if (!recordable(message) || isRead(message)) return false;
        const absentAt = index < chat.length - 1 ? seedFrom(chat.slice(0, index)) ?? [] : absentIn(live);
        return noteLine(message, fresh(message, absentAt));
    }

    /** Continue rules: a read line's away list can only shrink; an unread line is a new one. */
    function recordContinued(message, live, target = round) {
        if (!recordable(message)) return false;
        if (!isRead(message)) return noteLine(message, fresh(message, absentIn(live)), target);
        const { record, invalid } = readRecord(message.extra);
        if (invalid) warnNote();
        if (!record?.away.length) return false;
        const seen = fresh(message, absentIn(live)).away;
        const away = record.away.filter(avatar => seen.includes(avatar));
        return away.length < record.away.length && noteLine(message, { ...record, away }, target);
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

    function chatChanged() {
        checkJoins('CHAT_CHANGED');
        round = null;
        saver.reset();
        setLastError(null);
        read = new WeakMap();
        readAll(liveScene());
    }

    async function messageSent(id) {
        adopt();
        const intent = checkJoins('MESSAGE_SENT', { id });
        const live = liveScene();
        const index = Number(id);
        const inserted = index < chatOf().length - 1;
        const wrote = Boolean(live) && recordNew(index, live);
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
                wrote = recordable(message) && noteLine(message, fresh(message, absentIn(live)));
            } else wrote = recordNew(index, live);
        }
        let save = strongest(intent, wrote ? receivedSave(type, index < chat.length - 1) : null);
        if (HOST_SAVED.has(type)) {
            // The host's save right after this event carries every change made so far.
            saver.clearUnsaved();
            if (save !== 'await' && host.isGenerating() === true) save = null;
        }
        await persist(save);
    }

    function messageSwiped(id) {
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
        // n>1 alternatives and /swipes-add versions are read when first shown on the newest line.
        if (index === chat.length - 1 && recordable(message) && !isRead(message)) noteLine(message, fresh(message, absentIn(live)));
    }

    /** deleteSwipe renumbers the versions above the deleted one (script.js:15448-15466). */
    function swipeDeleted(details) {
        if (!isRecord(details)) return;
        const { messageId, swipeId } = details;
        const message = chatOf()[Number(messageId)];
        const seen = isRecord(message) ? read.get(message) : undefined;
        if (!seen || !Number.isInteger(swipeId) || swipeId < 0) return;
        read.set(message, new Set([...seen].filter(version => version !== swipeId)
            .map(version => version > swipeId ? version - 1 : version)));
    }

    function startRound(info) {
        const live = liveScene();
        if (!live) {
            round = null;
            return;
        }
        const chat = chatOf();
        const last = chat[chat.length - 1];
        const entries = new WeakMap();
        for (const message of chat) if (isRecord(message)) entries.set(message, lengthOf(message.swipe_info));
        round = {
            key: live.key,
            type: typeof info?.type === 'string' && info.type ? info.type : 'normal',
            started: true,
            startLength: chat.length,
            last: isRecord(last) ? { message: last, versions: versionCount(last), text: last.mes } : null,
            entries,
            recorded: new Map(),
            continued: false,
        };
    }

    /** Lines a round wrote without MESSAGE_RECEIVED, such as a stopped stream (script.js:6798-6806). */
    function sweep(ended, live) {
        const chat = chatOf();
        const absent = absentIn(live);
        let wrote = false;
        for (let index = ended.startLength; index < chat.length; index++) {
            const message = chat[index];
            if (recordable(message) && !message.is_user && !isRead(message)) {
                wrote = noteLine(message, fresh(message, absent), ended) || wrote;
            }
        }
        const newest = chat[chat.length - 1];
        if (!recordable(newest)) return wrote;
        // A swipe that got no reply still shows its empty slot here; the host puts the old version back after the round.
        if (ended.type === 'swipe' && !isEmptySlot(newest) && !isRead(newest)) {
            wrote = noteLine(newest, fresh(newest, absent), ended) || wrote;
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
        round = null;
        try {
            const live = liveScene();
            if (ended?.started && live && ended.key === live.key && SWEEP_TYPES.has(ended.type)) {
                const swept = sweep(ended, live);
                if (stripCopies(ended) || swept) saver.markUnsaved();
            }
        } finally {
            await saver.flush();
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
        MESSAGE_DELETED: () => saver.noteDelete(),
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
    }

    let active = memoryActive(settings.get());
    let token = settings.get().scene_history_since;

    // A new or renewed token is a turn-on (§J.3). The check's own settings writes re-enter here as no change.
    function settingsChanged() {
        if (destroyed) return;
        try {
            const config = settings.get();
            const wasActive = active;
            const renewed = config.scene_history_since !== token;
            active = memoryActive(config);
            token = config.scene_history_since;
            if (wasActive && !active) joins.reset();
            if (!active || (wasActive && !renewed)) return;
            checkJoins('turn-on');
            if (!wasActive) readAll(liveScene());
        } catch (error) {
            logOnce(EVENT_FAILED, error);
        }
    }

    const stopEvents = host.onHostEvents(HOST_EVENTS, onHostEvent);
    const stopSettings = settings.subscribe(settingsChanged);

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        stopEvents();
        stopSettings();
        round = null;
        listeners.clear();
        joins.destroy();
        saver.destroy();
    }

    // GCO can start after the chat's CHAT_CHANGED; the init check sets the cursor before the first filter.
    try {
        checkJoins('init');
        readAll(liveScene());
    } catch (error) {
        logOnce(EVENT_FAILED, error);
    }

    return {
        filter,
        hiddenFor,
        status,
        isOmniscient: avatar => omniscientIn(settings.get(), avatar),
        setOmniscient,
        subscribe(listener) {
            if (destroyed) return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        destroy,
    };
}
