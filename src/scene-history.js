// Pure presence notes on chat lines and the per-speaker hiding plan. No host access, saves or events.
export const RECORD_KEY = 'sbu_scene';
export const HIDE_TYPES = new Set(['normal', 'swipe', 'continue']);

const MAX_ENTRIES = 64;
const MAX_AVATAR = 255;
const arrivalsFrom = new Set(['absent', 'remote']);
const departuresFrom = new Set(['present', 'unspecified']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key);
const isAvatar = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_AVATAR;
const arrayOf = value => Array.isArray(value) ? value : [];
const sortedUnique = values => [...new Set(values)].sort();

function legalMove(entry) {
    if (!Array.isArray(entry) || entry.length !== 3 || !isAvatar(entry[0])) return false;
    const [, from, to] = entry;
    return (to === 'present' && arrivalsFrom.has(from)) || (to === 'absent' && departuresFrom.has(from));
}

function readList(stored, name, valid) {
    if (!own(stored, name) || stored[name] === undefined) return [];
    const value = stored[name];
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ENTRIES || !value.every(valid)) return null;
    return value;
}

/** Validate one stored note; anything malformed is no record at all. */
export function readRecord(extra) {
    if (!own(extra, RECORD_KEY) || extra[RECORD_KEY] === undefined) return { record: null, invalid: false };
    const stored = extra[RECORD_KEY];
    const invalid = { record: null, invalid: true };
    if (!isRecord(stored) || stored.v !== 1) return invalid;
    const away = readList(stored, 'away', isAvatar);
    const moved = readList(stored, 'moved', legalMove);
    const undone = readList(stored, 'undone', isAvatar);
    if (!away || !moved || !undone) return invalid;
    return { record: { away: [...away], moved: moved.map(entry => [...entry]), undone: [...undone] }, invalid: false };
}

export function emptyRecord(rec) {
    return !arrayOf(rec?.away).length && !arrayOf(rec?.moved).length && !arrayOf(rec?.undone).length;
}

function storedForm(rec) {
    const stored = { v: 1 };
    const away = sortedUnique(arrayOf(rec.away));
    const moved = arrayOf(rec.moved).map(entry => [...entry]);
    const undone = sortedUnique(arrayOf(rec.undone));
    if (away.length) stored.away = away;
    if (moved.length) stored.moved = moved;
    if (undone.length) stored.undone = undone;
    return stored;
}

function shownEntry(message) {
    const { swipe_info: swipes, swipe_id: swipeId } = message;
    if (!Array.isArray(swipes) || !Number.isInteger(swipeId) || swipeId < 0) return undefined;
    return isRecord(swipes[swipeId]) ? swipes[swipeId] : undefined;
}

/** Put the note on the line and on its shown swipe entry, or remove it from both when empty. */
export function writeRecord(message, rec) {
    if (!isRecord(message)) return;
    const empty = emptyRecord(rec);
    for (const target of [message, shownEntry(message)]) {
        if (!target) continue;
        if (empty) {
            if (isRecord(target.extra)) delete target.extra[RECORD_KEY];
            continue;
        }
        if (!isRecord(target.extra)) target.extra = {};
        target.extra[RECORD_KEY] = storedForm(rec);
    }
}

/**
 * Swipe alternatives can share one extra object with the shown version, so the
 * alternative gets its own copy instead of losing the key in place.
 */
export function stripRecord(entry) {
    if (!own(entry, 'extra') || !own(entry.extra, RECORD_KEY)) return;
    const copy = { ...entry.extra };
    delete copy[RECORD_KEY];
    entry.extra = copy;
}

export function authorOf(message) {
    if (!isRecord(message) || message.is_user || (isRecord(message.extra) && message.extra.type === 'narrator')) return undefined;
    return typeof message.original_avatar === 'string' && message.original_avatar ? message.original_avatar : undefined;
}

export function resolveChange(status, to) {
    if (to === 'present' && arrivalsFrom.has(status)) return { from: status, to };
    if (to === 'absent' && departuresFrom.has(status)) return { from: status, to };
    return null;
}

/** Anyone present at the start or at the end of a line, and its author, saw it. */
export function computeAway({ absentAt, movers, author }) {
    const skip = new Set(movers ?? []);
    if (typeof author === 'string') skip.add(author);
    return sortedUnique([...(absentAt ?? [])].filter(avatar => isAvatar(avatar) && !skip.has(avatar)));
}

export function absentAfter(rec) {
    const moved = arrayOf(rec?.moved);
    const arrivals = new Set(moved.filter(([, , to]) => to === 'present').map(([avatar]) => avatar));
    const departures = moved.filter(([, , to]) => to === 'absent').map(([avatar]) => avatar);
    return sortedUnique([...arrayOf(rec?.away), ...departures]).filter(avatar => !arrivals.has(avatar));
}

const recordOf = message => isRecord(message) ? readRecord(message.extra).record : null;

/** Each member's newest change on a shown version; hidden lines count, and the last entry of a line wins. */
export function latestChanges(chat) {
    const latest = new Map();
    const messages = arrayOf(chat);
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const moved = recordOf(message)?.moved ?? [];
        for (let position = moved.length - 1; position >= 0; position--) {
            const entry = moved[position];
            if (!latest.has(entry[0])) latest.set(entry[0], { index, message, swipeId: message.swipe_id, entry });
        }
    }
    return latest;
}

/** Lines a departure hid from `avatar`, newest first. */
export function revealWalk(chat, avatar) {
    const found = [];
    const messages = arrayOf(chat);
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const record = recordOf(message);
        if (record?.away.includes(avatar)) found.push(index);
        else if (authorOf(message) === avatar) continue;
        else if (isRecord(message) && message.is_system && !record) continue;
        else break;
    }
    return found;
}

/** Only the newest visible line counts: a line without a note was written with nobody away. */
export function seedFrom(chat) {
    const messages = arrayOf(chat);
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (isRecord(message) && message.is_system) continue;
        const record = recordOf(message);
        return record ? absentAfter(record) : null;
    }
    return null;
}

/** First matching rule per prompt item: 'away', 'joined' or null (kept). */
export function planHidden(items, { speaker, type, omniscient = false, joinTime, timeOf } = {}) {
    const list = arrayOf(items);
    const plan = list.map(() => null);
    if (!HIDE_TYPES.has(type) || typeof speaker !== 'string' || !speaker || omniscient) return plan;
    const byJoin = Number.isFinite(joinTime) && typeof timeOf === 'function';
    const last = list.length - 1;
    for (let index = 0; index <= last; index++) {
        const item = list[index];
        if (!isRecord(item) || (type === 'continue' && index === last) || authorOf(item) === speaker) continue;
        if (readRecord(item.extra).record?.away.includes(speaker)) plan[index] = 'away';
        else if (byJoin) {
            const time = timeOf(item.send_date);
            if (typeof time === 'number' && time <= joinTime) plan[index] = 'joined';
        }
    }
    return plan;
}

/** Builds every replacement before assigning any, so a throw leaves the items untouched. */
export function blankItems(items, plan, ignore) {
    if (!Array.isArray(items) || (typeof ignore !== 'symbol' && typeof ignore !== 'string')) return 0;
    const replacements = [];
    for (const [index, item] of items.entries()) {
        if (!plan?.[index] || !isRecord(item)) continue;
        replacements.push([index, { ...item, mes: '', name: '', is_user: false, agentContributions: undefined,
            extra: { ...(isRecord(item.extra) ? item.extra : {}), [ignore]: true } }]);
    }
    for (const [index, replacement] of replacements) items[index] = replacement;
    return replacements.length;
}

/** The planner over the live chat as a normal reply would see it; host-hidden lines are not counted. */
export function countHidden(chat, options = {}) {
    const indexes = [];
    const items = [];
    for (const [index, message] of arrayOf(chat).entries()) {
        if (!isRecord(message) || message.is_system) continue;
        indexes.push(index);
        items.push(message);
    }
    const counts = { away: 0, joined: 0, lines: [] };
    planHidden(items, { ...options, type: 'normal' }).forEach((rule, position) => {
        if (!rule) return;
        counts[rule]++;
        counts.lines.push({ index: indexes[position], rule });
    });
    return counts;
}
