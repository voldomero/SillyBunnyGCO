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
        seedFrom, stripRecord, writeRecord,
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

    function batchFor(key) {
        if (pending?.key !== key) pending = { key, queue: [], planned: [] };
        return pending;
    }

    /**
     * Each member's status before the next line: the live scene with queued changes applied in order (§6), and
     * for each member the queued change that set it.
     */
    function overlayOf(live) {
        const status = statusesOf(live);
        const latest = new Map();
        for (const change of queueOf(live)) {
            const { avatar, to } = change;
            if (!status.has(avatar) || !resolveChange(status.get(avatar), to)) continue;
            status.set(avatar, to);
            latest.set(avatar, change);
        }
        return { status, latest };
    }

    /** Apply changes in order where each member's live status still allows it; one toast per applied batch. */
    function apply(changes, key) {
        const status = statusesOf(scene.getSnapshot());
        const done = [];
        for (const change of changes) {
            const allowed = status.has(change.avatar) && resolveChange(status.get(change.avatar), change.to);
            if (!allowed || !scene.setState(change.avatar, change.to, key).ok) continue;
            status.set(change.avatar, change.to);
            done.push({ change, from: allowed.from });
        }
        if (done.length) host.toast({ level: 'info', text: SCENE_TEXT.P11 });
        return done;
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

    /**
     * Note a new line or version against the overlay (§4): the planned changes it carries, then those its text
     * makes when `detected`. Its own changes apply now or wait for the drain.
     */
    function noteFresh(message, live, { detected = true, planned = [], target = round } = {}) {
        const { status, latest } = overlayOf(live);
        const moved = planned.map(({ avatar, from, to }) => [avatar, from, to]);
        for (const { avatar, to } of detected ? detectLine(message, live) : []) {
            if (!status.has(avatar) || moved.some(([mover]) => mover === avatar)) continue;
            const change = resolveChange(status.get(avatar), to);
            if (change) moved.push([avatar, change.from, change.to]);
        }
        const away = computeAway({ absentAt: absentIn(status), movers: moved.map(([avatar]) => avatar),
            author: authorOf(message) });
        const changed = noteLine(message, { away, moved, undone: [] }, target);
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

    // setState refuses a stale key, so what waits for the old chat is dropped (§12).
    function chatChanged() {
        checkJoins('CHAT_CHANGED');
        const dropped = pending !== null;
        round = null;
        pending = null;
        saver.reset();
        setLastError(null);
        read = new WeakMap();
        readAll(liveScene());
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
            wrote = recordNew(index, live, { planned: carries ? pending.planned.splice(0) : [] });
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
        if (index === chat.length - 1 && recordable(message) && !isRead(message)) noteFresh(message, live);
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
            const done = apply(detectIn(text, live, { kind: 'user' }), key);
            batchFor(key).planned.push(...done.map(({ change: { avatar, to }, from }) => ({ avatar, from, to })));
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
     * rest are discarded. True when a note changed.
     */
    function drain() {
        if (round || holds > 0 || !pending) return false;
        const batch = pending;
        pending = null;
        let wrote = false;
        try {
            const live = liveScene();
            let dropped = batch.queue;
            if (live?.key === batch.key && detecting()) {
                for (const { avatar, from, to } of batch.planned) {
                    if (statusesOf(scene.getSnapshot()).get(avatar) === to) scene.setState(avatar, from, batch.key);
                }
                const done = new Set(apply(batch.queue.filter(stillListed), batch.key).map(({ change }) => change));
                dropped = batch.queue.filter(change => !done.has(change));
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
            if (drain()) saver.markUnsaved();
            await saver.flush();
        }
    }

    // A change is named by its line object, which outlives the index shifts of deletes and inserts, and by its
    // direction: a line version moves a member at most once each way.
    function changeId(message, avatar, to) {
        if (!serials.has(message)) serials.set(message, ++serial);
        return JSON.stringify([serials.get(message), versionOf(message), avatar, to]);
    }

    /** Each member's latest applied change and every queued one, in chat order, for the changes list. */
    function getChanges() {
        try {
            const live = liveScene();
            if (!live) return [];
            const queue = queueOf(live);
            const names = new Map(live.participants.map(member => [member.avatar, member.name]));
            const lines = [];
            for (const [index, message] of chatOf().entries()) {
                const moved = isRecord(message) ? readRecord(message.extra).record?.moved : undefined;
                if (moved?.length) lines.push({ index, message, moved });
            }
            const queued = (message, [avatar, , to]) => queue.some(change => change.message === message
                && change.avatar === avatar && change.to === to && change.version === versionOf(message));
            const latest = new Map();
            for (const { message, moved } of lines) {
                for (const entry of moved) if (!queued(message, entry)) latest.set(entry[0], entry);
            }
            return lines.flatMap(({ index, message, moved }) => moved.flatMap(entry => {
                const isPending = queued(message, entry);
                if (!isPending && latest.get(entry[0]) !== entry) return [];
                const [avatar, from, to] = entry;
                return [{ id: changeId(message, avatar, to), avatar, name: names.get(avatar) ?? avatar, from, to, index,
                    excerpt: excerptOf(message.mes), pending: isPending }];
            }));
        } catch (error) {
            logOnce(CHANGES_FAILED, error);
            return [];
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
            // queued ones leave the notes, so they hide nothing.
            if (wasAutomatic && !automatic && pending) {
                const batch = pending;
                pending = null;
                if (discard(batch.queue)) persistLater();
                notify();
            }
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
        pending = null;
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
        prepareTurn,
        hold,
        getChanges,
        subscribe(listener) {
            if (destroyed) return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        destroy,
    };
}
