// Pure join roster kept in the group chat header. No host access, saves or events.
export const ROSTER_KEY = 'sbu_scene_roster';

const MAX_LIST = 2000;
const MAX_TEXT = 255;
const MAX_REVEALS = 500;
// The largest time a Date can hold; anything above would make toISOString throw.
const MAX_TIME = 8.64e15;
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key);
const isText = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
const isKey = value => typeof value === 'string' && value.length > 0;
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME;
const toIso = ms => new Date(ms).toISOString();
const sorted = values => [...values].sort();
const byAvatar = (left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
const textSet = values => new Set((Array.isArray(values) ? values : []).filter(isText));
const sameList = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const readOnly = value => timeOf(value);

function authorOf(line) {
    if (!isRecord(line) || line.is_user || (isRecord(line.extra) && line.extra.type === 'narrator')) return undefined;
    return isText(line.original_avatar) ? line.original_avatar : undefined;
}

function uniqueTexts(value) {
    if (!Array.isArray(value) || value.length > MAX_LIST) return null;
    const seen = new Set();
    for (const entry of value) {
        if (!isText(entry) || seen.has(entry)) return null;
        seen.add(entry);
    }
    return seen;
}

function makeRoster({ group, since, floor, known, gone, joins }) {
    const knownSet = new Set(known);
    return {
        v: 1,
        group,
        since,
        floor,
        known: sorted(knownSet),
        gone: sorted([...gone].filter(avatar => !knownSet.has(avatar))),
        joined: [...joins].filter(([avatar]) => knownSet.has(avatar)).map(([avatar, time]) => [avatar, time]).sort(byAvatar),
    };
}

function sameRoster(left, right) {
    return left.group === right.group && left.since === right.since && Object.is(left.floor, right.floor)
        && sameList(left.known, right.known) && sameList(left.gone, right.gone)
        && left.joined.length === right.joined.length
        && left.joined.every(([avatar, time], index) => avatar === right.joined[index][0] && time === right.joined[index][1]);
}

/** Validate a stored roster. Lists come back sorted; unknown fields are left behind. */
export function readRoster(value) {
    if (value === undefined || value === null) return { state: 'missing', roster: null };
    const invalid = { state: 'invalid', roster: null };
    if (!isRecord(value)) return invalid;
    const field = key => own(value, key) ? value[key] : undefined;
    if (typeof field('v') === 'number' && field('v') > 1) return { state: 'foreign', roster: null };
    if (field('v') !== 1 || !isText(field('group')) || !isText(field('since'))) return invalid;
    const known = uniqueTexts(field('known'));
    const gone = field('gone') === undefined ? new Set() : uniqueTexts(field('gone'));
    const joined = field('joined');
    if (!known || !gone || !Array.isArray(joined) || joined.length > MAX_LIST) return invalid;
    const joins = new Map();
    for (const pair of joined) {
        if (!Array.isArray(pair) || pair.length !== 2) return invalid;
        const [avatar, time] = pair;
        if (!known.has(avatar) || joins.has(avatar) || typeof time !== 'string' || Number.isNaN(Date.parse(time))) return invalid;
        joins.set(avatar, time);
    }
    return { state: 'valid', roster: makeRoster({ group: field('group'), since: field('since'),
        floor: own(value, 'floor') ? value.floor : null, known, gone, joins }) };
}

/**
 * Line time in ms, or NaN. `parse` is the host's timestampToMoment when it has one;
 * without it only digit strings and ISO 8601 with a zone are read.
 */
export function timeOf(value, parse) {
    if (typeof value === 'number') return validTime(value) ? value : NaN;
    if (typeof value !== 'string') return NaN;
    if (typeof parse === 'function') {
        try {
            const moment = parse(value);
            if (!moment || typeof moment.isValid !== 'function' || !moment.isValid()) return NaN;
            const ms = Number(moment.valueOf());
            return validTime(ms) ? ms : NaN;
        } catch {
            return NaN;
        }
    }
    let ms = NaN;
    if (/^\d+$/.test(value)) ms = Number(value);
    else if (ISO_ZONED.test(value)) ms = Date.parse(value);
    return validTime(ms) ? ms : NaN;
}

/** Newest time over every line and version, hidden lines included, capped at `now`. */
export function newestTime(chat, read = readOnly, now = Infinity, { skipLast = false } = {}) {
    if (!Array.isArray(chat)) return null;
    let newest = -Infinity;
    const consider = value => {
        const time = read(value);
        if (validTime(time) && time > newest) newest = time;
    };
    const end = skipLast ? chat.length - 1 : chat.length;
    for (let index = 0; index < end; index++) {
        const line = chat[index];
        if (!isRecord(line)) continue;
        consider(line.send_date);
        if (!Array.isArray(line.swipe_info)) continue;
        for (const version of line.swipe_info) if (isRecord(version)) consider(version.send_date);
    }
    if (newest === -Infinity) return null;
    return typeof now === 'number' && newest > now ? now : newest;
}

/** Oldest readable line time; versions are not read. */
export function oldestTime(chat, read = readOnly) {
    if (!Array.isArray(chat)) return null;
    let oldest = Infinity;
    for (const line of chat) {
        if (!isRecord(line)) continue;
        const time = read(line.send_date);
        if (validTime(time) && time < oldest) oldest = time;
    }
    return oldest === Infinity ? null : oldest;
}

function firstOwnTimes(chat, read, avatars) {
    const first = new Map();
    for (const line of Array.isArray(chat) ? chat : []) {
        const author = authorOf(line);
        if (!avatars.has(author)) continue;
        const time = read(line.send_date);
        if (validTime(time) && (!first.has(author) || time < first.get(author))) first.set(author, time);
    }
    return first;
}

function outcome(state, fields = {}) {
    return { state, next: null, changed: false, joined: [], founded: [], returned: [], pruned: [], revealed: [],
        warning: null, ...fields };
}

/**
 * One join check (steps 1-6 of the check). `founders` must already be limited to chats
 * that existed at turn-on, and `reveals` to this chat. Nothing passed in is changed.
 */
export function reconcileRoster({ stored, groupId, members, cards, founders, reveals, chat, since, cursor,
    fromFile = false, now = Infinity, timeOf: read = readOnly } = {}) {
    const cardSet = cards instanceof Set ? cards : textSet(cards);
    const memberSet = textSet(members);
    const group = groupId === undefined || groupId === null ? '' : String(groupId);
    if (!cardSet.size || [...memberSet].some(avatar => !cardSet.has(avatar)) || !isText(group) || !isText(since)) {
        return outcome('guarded');
    }
    const { state: storedState, roster } = readRoster(stored);
    if (storedState === 'foreign') return outcome('foreign', { warning: 'foreign' });
    const previous = roster?.group === group ? roster : null;
    const state = !previous ? 'fresh' : previous.since !== since ? 'rebuilt' : 'checked';
    const known = new Set(previous?.known);
    const gone = new Set(previous?.gone);
    const joins = new Map(previous?.joined);
    const newcomers = [];

    if (state === 'checked') {
        for (const avatar of memberSet) {
            if (!known.has(avatar) && !gone.has(avatar)) newcomers.push(avatar);
            known.add(avatar);
        }
    } else {
        const seen = new Set(textSet(founders));
        // Authors of a chat imported from another group never belonged to this one.
        const imported = Boolean(roster) && roster.group !== group;
        for (const line of !imported && Array.isArray(chat) ? chat : []) {
            const author = authorOf(line);
            if (author !== undefined) seen.add(author);
        }
        for (const avatar of memberSet) known.add(avatar);
        for (const avatar of seen) (cardSet.has(avatar) ? known : gone).add(avatar);
    }

    const pruned = [];
    for (const avatar of known) {
        if (memberSet.has(avatar) || cardSet.has(avatar)) continue;
        known.delete(avatar);
        gone.add(avatar);
        joins.delete(avatar);
        pruned.push(avatar);
    }
    const returned = [...gone].filter(avatar => known.has(avatar));
    for (const avatar of returned) gone.delete(avatar);

    // A rename or deletion seen together with an add, or no dated line yet, leaves
    // no safe join time, so those newcomers count as founders.
    if (newcomers.length && validTime(cursor) && !pruned.length) {
        const ownFirst = fromFile ? firstOwnTimes(chat, read, new Set(newcomers)) : new Map();
        for (const avatar of newcomers) {
            const first = ownFirst.get(avatar);
            joins.set(avatar, toIso(first === undefined ? cursor : Math.min(cursor, first - 1)));
        }
    }

    const revealed = [...textSet(reveals)].filter(avatar => joins.delete(avatar));
    let floor = previous?.floor;
    if (state === 'fresh') {
        const newest = newestTime(chat, read, now);
        floor = newest === null ? null : toIso(newest);
    }
    const next = makeRoster({ group, since, floor, known, gone, joins });
    // A roster past the limit would read back as invalid and reset, so nothing is written.
    if ([next.known, next.gone, next.joined].some(list => list.length > MAX_LIST)) return outcome('guarded');
    const before = new Set([...(previous?.known ?? []), ...(previous?.gone ?? [])]);
    const revealedSet = new Set(revealed);
    return outcome(state, {
        next,
        changed: !roster || !sameRoster(roster, next),
        joined: sorted(newcomers.filter(avatar => joins.has(avatar))),
        founded: next.known.filter(avatar => !before.has(avatar) && !joins.has(avatar) && !revealedSet.has(avatar)),
        returned: sorted(returned),
        pruned: sorted(pruned),
        revealed: sorted(revealed),
        warning: storedState === 'invalid' ? 'invalid' : null,
    });
}

/** Lower every join at or after line time `t` to `t - 1 ms`; never raises one. */
export function clampJoins(roster, t) {
    if (!validTime(t) || !Array.isArray(roster?.joined)) return roster;
    let changed = false;
    const joined = roster.joined.map(([avatar, time]) => {
        if (!(t <= Date.parse(time))) return [avatar, time];
        changed = true;
        return [avatar, toIso(t - 1)];
    });
    return changed ? { ...roster, joined } : roster;
}

/** Drop one member's join; they stay known and see every earlier line. */
export function removeJoin(roster, avatar) {
    if (!Array.isArray(roster?.joined) || !roster.joined.some(pair => pair[0] === avatar)) return roster;
    return { ...roster, joined: roster.joined.filter(pair => pair[0] !== avatar) };
}

/**
 * Move `from` to `to` in every list. When both already count for this chat, the earlier
 * join wins and anyone without a join (a founder or a gone avatar) counts as earliest.
 */
export function renameInRoster(roster, from, to) {
    if (!Array.isArray(roster?.known) || !isText(from) || !isText(to) || from === to) return roster;
    const known = new Set(roster.known);
    const gone = new Set(roster.gone);
    if (!known.has(from) && !gone.has(from)) return roster;
    const joins = new Map(roster.joined);
    const fromJoin = joins.get(from);
    const toJoin = joins.get(to);
    const merging = known.has(to) || gone.has(to);
    const stays = known.has(from) || known.has(to);
    for (const list of [known, gone, joins]) {
        list.delete(from);
        list.delete(to);
    }
    (stays ? known : gone).add(to);
    let join = fromJoin;
    if (merging) {
        join = fromJoin === undefined || toJoin === undefined ? undefined
            : Date.parse(fromJoin) <= Date.parse(toJoin) ? fromJoin : toJoin;
    }
    if (join !== undefined) joins.set(to, join);
    return makeRoster({ ...roster, known, gone, joins });
}

/** Join time in ms for a joiner; undefined for founders and anyone else. */
export function joinWindowFor(roster, avatar) {
    if (!Array.isArray(roster?.joined)) return undefined;
    const pair = roster.joined.find(entry => Array.isArray(entry) && entry[0] === avatar);
    const time = pair ? Date.parse(pair[1]) : NaN;
    return Number.isNaN(time) ? undefined : time;
}

const isPair = pair => Array.isArray(pair) && pair.length === 2 && isKey(pair[0]) && isText(pair[1]);
const samePair = (pair, chatKey, avatar) => pair[0] === chatKey && pair[1] === avatar;

/** Avatars with a pending reveal in this chat. */
export function revealsFor(pairs, chatKey) {
    if (!Array.isArray(pairs)) return [];
    return [...new Set(pairs.filter(pair => isPair(pair) && pair[0] === chatKey).map(pair => pair[1]))];
}

/** Add a pair as the newest; a repeat moves to the end and the oldest go past the limit. */
export function addRevealPair(pairs, chatKey, avatar) {
    if (!isKey(chatKey) || !isText(avatar)) return pairs;
    const kept = (Array.isArray(pairs) ? pairs : [])
        .filter(pair => isPair(pair) && !samePair(pair, chatKey, avatar))
        .map(([key, name]) => [key, name]);
    kept.push([chatKey, avatar]);
    return kept.slice(-MAX_REVEALS);
}

export function dropRevealPair(pairs, chatKey, avatar) {
    if (!Array.isArray(pairs) || !pairs.some(pair => isPair(pair) && samePair(pair, chatKey, avatar))) return pairs;
    return pairs.filter(pair => isPair(pair) && !samePair(pair, chatKey, avatar)).map(([key, name]) => [key, name]);
}
