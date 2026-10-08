import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ROSTER_KEY, addRevealPair, clampJoins, dropRevealPair, joinWindowFor, newestTime, oldestTime,
    readRoster, reconcileRoster, removeJoin, renameInRoster, revealsFor, timeOf,
} from '../src/scene-roster.js';

const iso = ms => new Date(ms).toISOString();
const read = value => timeOf(value);
const T0 = Date.UTC(2026, 9, 8, 0, 57, 41, 200);
const CURSOR = Date.UTC(2026, 9, 8, 1, 12, 3, 456);

const said = (avatar, ms, more = {}) => ({ name: avatar, original_avatar: avatar, is_user: false, mes: 'line',
    send_date: iso(ms), ...more });
const typed = (ms, more = {}) => ({ name: 'User', is_user: true, mes: 'line', send_date: iso(ms), ...more });

/** Alice greets, the user answers, Bob replies: dated T0, T0 + 1 s and T0 + 2 s. */
const chat = deepFreeze([said('a.png', T0), typed(T0 + 1000), said('b.png', T0 + 2000)]);

function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const inner of Object.values(value)) deepFreeze(inner);
        Object.freeze(value);
    }
    return value;
}

const roster = (fields = {}) => ({ v: 1, group: 'g1', since: 'T1', floor: null, known: ['a.png', 'b.png'],
    gone: [], joined: [], ...fields });

/** A check of group g1 under token T1 where every avatar used below has a card. Inputs are frozen. */
const check = (fields = {}) => {
    const input = {
        stored: roster(), groupId: 'g1', members: ['a.png', 'b.png'],
        cards: new Set(['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png']), founders: [], reveals: [], chat,
        since: 'T1', cursor: CURSOR, fromFile: false, now: Infinity, timeOf: read, ...fields,
    };
    for (const key of ['stored', 'members', 'founders', 'reveals', 'chat']) deepFreeze(input[key]);
    return reconcileRoster(input);
};

const GUARDED = { state: 'guarded', next: null, changed: false, joined: [], founded: [], returned: [],
    pruned: [], revealed: [], warning: null };

test('names the chat header key', () => {
    assert.equal(ROSTER_KEY, 'sbu_scene_roster');
});

test('a newcomer joins at the cursor', () => {
    const stored = { v: 1, group: 'g1', since: 'T1', floor: null, known: ['a.png', 'b.png'], gone: [], joined: [] };
    const result = reconcileRoster({ stored, groupId: 'g1', members: ['a.png', 'b.png', 'd.png'],
        cards: new Set(['a.png', 'b.png', 'd.png']), founders: [], reveals: [], chat, since: 'T1',
        cursor: Date.UTC(2026, 9, 8, 1, 12, 3, 456), fromFile: false, now: Infinity, timeOf: read });
    assert.equal(result.state, 'checked');
    assert.equal(result.changed, true);
    assert.deepEqual(result.joined, ['d.png']);
    assert.deepEqual(result.next.joined, [['d.png', '2026-10-08T01:12:03.456Z']]);
    assert.deepEqual(result.next.known, ['a.png', 'b.png', 'd.png']);
});

test('validates rosters', () => {
    const joinTime = '2026-10-08T01:12:03.456Z';
    const valid = { v: 1, group: 'g1', since: 'T1', floor: '2026-10-08T00:57:41.200Z',
        known: ['b.png', 'a.png'], gone: ['z.png'], joined: [['b.png', joinTime]], note: 'dropped' };
    assert.deepEqual(readRoster(valid), { state: 'valid', roster: { v: 1, group: 'g1', since: 'T1',
        floor: '2026-10-08T00:57:41.200Z', known: ['a.png', 'b.png'], gone: ['z.png'], joined: [['b.png', joinTime]] } });
    assert.deepEqual(readRoster({ ...valid, v: 2 }), { state: 'foreign', roster: null });
    assert.deepEqual(readRoster(undefined), { state: 'missing', roster: null });
    assert.deepEqual(readRoster(null), { state: 'missing', roster: null });

    const invalid = [
        'not a roster',
        [valid],
        { ...valid, v: '2' },
        { ...valid, v: 0 },
        { ...valid, group: '' },
        { ...valid, since: 7 },
        { ...valid, group: 'g'.repeat(256) },
        { ...valid, known: ['a.png', 'a.png'] },
        { ...valid, known: ['a.png', ''] },
        { ...valid, known: undefined },
        { ...valid, gone: ['z.png', 'z.png'] },
        { ...valid, gone: null },
        { ...valid, joined: undefined },
        { ...valid, joined: [['c.png', joinTime]] },
        { ...valid, joined: [['b.png', 'whenever']] },
        { ...valid, joined: [['b.png', joinTime], ['b.png', joinTime]] },
        { ...valid, joined: [['b.png']] },
        { ...valid, known: Array.from({ length: 2001 }, (_, index) => `m${index}.png`), joined: [] },
    ];
    for (const value of invalid) assert.deepEqual(readRoster(value), { state: 'invalid', roster: null }, JSON.stringify(value)?.slice(0, 80));

    const atLimit = readRoster({ ...valid, known: Array.from({ length: 2000 }, (_, index) => `m${index}.png`), joined: [] });
    assert.equal(atLimit.state, 'valid');

    const noGone = { ...valid };
    delete noGone.gone;
    assert.deepEqual(readRoster(noGone).roster.gone, []);
    assert.deepEqual(readRoster({ ...valid, gone: ['b.png', 'z.png'] }).roster.gone, ['z.png']);
    const garbage = { odd: [1, 2] };
    assert.equal(readRoster({ ...valid, floor: garbage }).roster.floor, garbage);
    assert.equal(readRoster({ ...valid, floor: 'not a date' }).roster.floor, 'not a date');
});

test('reads line times', () => {
    assert.equal(timeOf(1759885923456), 1759885923456);
    assert.equal(timeOf(0), 0);
    assert.ok(Number.isNaN(timeOf(-1)));
    assert.ok(Number.isNaN(timeOf(Number.POSITIVE_INFINITY)));
    assert.ok(Number.isNaN(timeOf(9e15)));
    assert.equal(timeOf('2026-10-08T01:12:03.456Z'), CURSOR);
    assert.equal(timeOf('2026-10-08T03:12:03.456+02:00'), CURSOR);
    assert.equal(timeOf('2026-10-08T01:12Z'), Date.UTC(2026, 9, 8, 1, 12));
    assert.ok(Number.isNaN(timeOf('2026-10-08T01:12:03.456')));
    assert.ok(Number.isNaN(timeOf('October 8, 2026 1:12am')));
    assert.ok(Number.isNaN(timeOf('2026-13-40T01:12:03Z')));
    assert.equal(timeOf('1759885923456'), 1759885923456);
    for (const value of [undefined, null, '', true, {}, [], 12n]) assert.ok(Number.isNaN(timeOf(value)), String(value));

    const seen = [];
    const parse = value => {
        seen.push(value);
        return { isValid: () => true, valueOf: () => 42 };
    };
    assert.equal(timeOf('October 8, 2026 1:12am', parse), 42);
    assert.equal(timeOf(7, parse), 7);
    assert.deepEqual(seen, ['October 8, 2026 1:12am']);
    assert.ok(Number.isNaN(timeOf('nonsense', () => ({ isValid: () => false, valueOf: () => NaN }))));
    assert.ok(Number.isNaN(timeOf('nonsense', () => null)));
    assert.ok(Number.isNaN(timeOf('nonsense', () => { throw new Error('bad moment'); })));
});

test('finds the newest time over versions and hidden lines', () => {
    const hidden = [said('a.png', T0), said('b.png', T0 + 5000, { is_system: true }), typed(T0 + 1000)];
    assert.equal(newestTime(hidden, read, Infinity), T0 + 5000);
    const versions = [said('a.png', T0, { swipe_info: [{ send_date: iso(T0) }, null, { send_date: iso(T0 + 9000) }] }),
        said('b.png', T0 + 2000, { swipe_info: 'odd' }), 'not a line', null, typed(T0 + 3000)];
    assert.equal(newestTime(versions, read, Infinity), T0 + 9000);
});

test('skips the streaming line', () => {
    const streaming = [...chat, said('a.png', T0 + 9000, { swipe_info: [{ send_date: iso(T0 + 9500) }] })];
    assert.equal(newestTime(streaming, read, Infinity, { skipLast: true }), T0 + 2000);
    assert.equal(newestTime(streaming, read, Infinity), T0 + 9500);
    assert.equal(newestTime([said('a.png', T0)], read, Infinity, { skipLast: true }), null);
});

test('caps at now', () => {
    assert.equal(newestTime(chat, read, T0 + 1500), T0 + 1500);
    assert.equal(newestTime(chat, read, T0 + 9000), T0 + 2000);
    assert.equal(newestTime(chat, read, null), T0 + 2000);
});

test('returns null for an undated chat', () => {
    assert.equal(newestTime([], read, Infinity), null);
    assert.equal(newestTime(undefined, read, Infinity), null);
    assert.equal(newestTime([{ mes: 'x' }, { send_date: 'last Tuesday' }, { send_date: -4 }], read, Infinity), null);
});

test('finds the oldest readable line time', () => {
    const lines = [{ send_date: 'last Tuesday' }, said('a.png', T0 + 4000, { swipe_info: [{ send_date: iso(T0 - 9000) }] }),
        typed(T0 + 1000), null];
    assert.equal(oldestTime(lines, read), T0 + 1000);
    assert.equal(oldestTime([{ mes: 'x' }], read), null);
    assert.equal(oldestTime('chat', read), null);
});

test('creates a fresh roster with everyone a founder', () => {
    const history = [
        said('a.png', T0),
        said('c.png', T0 + 1000),
        said('x.png', T0 + 2000),
        typed(T0 + 3000, { original_avatar: 'u.png' }),
        said('n.png', T0 + 4000, { extra: { type: 'narrator' } }),
        said('b.png', T0 + 5000, { swipe_info: [{ send_date: iso(T0 + 6000) }] }),
    ];
    const result = check({ stored: undefined, chat: history, founders: ['e.png', 'y.png', 'a.png'],
        cards: new Set(['a.png', 'b.png', 'c.png', 'e.png', 'n.png', 'u.png']) });
    assert.equal(result.state, 'fresh');
    assert.equal(result.changed, true);
    assert.equal(result.warning, null);
    assert.deepEqual(result.next, { v: 1, group: 'g1', since: 'T1', floor: iso(T0 + 6000),
        known: ['a.png', 'b.png', 'c.png', 'e.png'], gone: ['x.png', 'y.png'], joined: [] });
    assert.deepEqual(result.founded, ['a.png', 'b.png', 'c.png', 'e.png']);
    assert.deepEqual(result.joined, []);

    const undated = check({ stored: undefined, chat: [] });
    assert.equal(undated.next.floor, null);
    assert.equal(check({ stored: undefined, now: T0 + 500 }).next.floor, iso(T0 + 500));
    assert.equal(check({ stored: undefined, groupId: 1759880000000 }).next.group, '1759880000000');
});

test('starts over after an import into another group', () => {
    const stored = roster({ group: 'g0', known: ['a.png', 'b.png'], joined: [['b.png', iso(T0)]] });
    const result = check({ stored: deepFreeze(stored) });
    assert.equal(result.state, 'fresh');
    assert.equal(result.changed, true);
    assert.equal(result.warning, null);
    assert.equal(result.next.group, 'g1');
    assert.deepEqual(result.next.joined, []);
    assert.equal(joinWindowFor(result.next, 'b.png'), undefined);
});

test('an earlier author of a chat imported into another group joins it later as a newcomer', () => {
    const history = deepFreeze([...chat, said('c.png', T0 + 3000), said('q.png', T0 + 4000)]);
    const stored = roster({ group: 'g0', known: ['a.png', 'b.png', 'c.png', 'q.png'] });
    const imported = check({ stored: deepFreeze(stored), chat: history });
    assert.equal(imported.state, 'fresh');
    assert.deepEqual(imported.next.known, ['a.png', 'b.png']);
    assert.deepEqual(imported.next.gone, []);
    assert.deepEqual(imported.founded, ['a.png', 'b.png']);

    const added = check({ stored: imported.next, members: ['a.png', 'b.png', 'c.png'], chat: history });
    assert.deepEqual(added.joined, ['c.png']);
    assert.deepEqual(added.next.joined, [['c.png', iso(CURSOR)]]);
});

test('rebuilds when the token changed', () => {
    const stored = roster({ since: 'T0', floor: 'old floor', known: ['a.png', 'b.png', 'd.png', 'z.png'],
        gone: ['c.png'], joined: [['d.png', iso(T0)], ['z.png', iso(T0)]] });
    const history = [...chat, said('c.png', T0 + 3000), said('q.png', T0 + 4000)];
    const result = check({ stored: deepFreeze(stored), members: ['a.png', 'b.png', 'd.png', 'e.png'],
        founders: ['f.png', 'w.png'], chat: history });
    assert.equal(result.state, 'rebuilt');
    assert.equal(result.changed, true);
    assert.deepEqual(result.next, { v: 1, group: 'g1', since: 'T1', floor: 'old floor',
        known: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'], gone: ['q.png', 'w.png', 'z.png'],
        joined: [['d.png', iso(T0)]] });
    assert.deepEqual(result.pruned, ['z.png']);
    assert.deepEqual(result.returned, ['c.png']);
    assert.deepEqual(result.founded, ['e.png', 'f.png']);
    assert.deepEqual(result.joined, []);
});

test('makes newcomers founders when the cursor is null or a card vanished in the same check', () => {
    const unsure = check({ members: ['a.png', 'b.png', 'd.png'], cursor: null });
    assert.equal(unsure.state, 'checked');
    assert.deepEqual(unsure.next.known, ['a.png', 'b.png', 'd.png']);
    assert.deepEqual(unsure.next.joined, []);
    assert.deepEqual(unsure.founded, ['d.png']);
    assert.deepEqual(unsure.joined, []);
    assert.deepEqual(check({ members: ['a.png', 'b.png', 'd.png'], cursor: Number.NaN }).next.joined, []);

    const stored = roster({ known: ['a.png', 'b.png', 'r.png'], joined: [['r.png', iso(T0)]] });
    const renamed = check({ stored: deepFreeze(stored), members: ['a.png', 'b.png', 'd.png'], reveals: ['r.png'] });
    assert.deepEqual(renamed.pruned, ['r.png']);
    assert.deepEqual(renamed.revealed, []);
    assert.deepEqual(renamed.next.known, ['a.png', 'b.png', 'd.png']);
    assert.deepEqual(renamed.next.gone, ['r.png']);
    assert.deepEqual(renamed.next.joined, []);
    assert.deepEqual(renamed.founded, ['d.png']);
    assert.deepEqual(renamed.joined, []);
});

test('keeps former members that still have a card', () => {
    const stored = roster({ known: ['a.png', 'b.png', 'c.png'], joined: [['c.png', iso(T0)]] });
    const result = check({ stored: deepFreeze(stored), members: ['a.png', 'b.png', 'd.png'] });
    assert.deepEqual(result.pruned, []);
    assert.deepEqual(result.next.known, ['a.png', 'b.png', 'c.png', 'd.png']);
    assert.deepEqual(result.next.joined, [['c.png', iso(T0)], ['d.png', iso(CURSOR)]]);
});

test('returns a member found in gone as a founder', () => {
    const stored = roster({ gone: ['d.png'] });
    const result = check({ stored: deepFreeze(stored), members: ['a.png', 'b.png', 'd.png'] });
    assert.equal(result.state, 'checked');
    assert.equal(result.changed, true);
    assert.deepEqual(result.returned, ['d.png']);
    assert.deepEqual(result.joined, []);
    assert.deepEqual(result.founded, []);
    assert.deepEqual(result.next.known, ['a.png', 'b.png', 'd.png']);
    assert.deepEqual(result.next.gone, []);
    assert.deepEqual(result.next.joined, []);
});

test('caps a join below the member\'s first own line when read from the file', () => {
    const T = T0 + 2000;
    const history = [
        said('d.png', T0 - 5000, { extra: { type: 'narrator' } }),
        typed(T0 - 4000, { original_avatar: 'd.png' }),
        said('a.png', T0),
        said('d.png', T + 1000),
        said('d.png', T),
    ];
    const members = ['a.png', 'b.png', 'd.png'];
    const fromFile = check({ members, chat: history, cursor: T0 + 9000, fromFile: true });
    assert.deepEqual(fromFile.next.joined, [['d.png', iso(T - 1)]]);
    assert.deepEqual(fromFile.joined, ['d.png']);
    const live = check({ members, chat: history, cursor: T0 + 9000, fromFile: false });
    assert.deepEqual(live.next.joined, [['d.png', iso(T0 + 9000)]]);
    const earlyCursor = check({ members, chat: history, cursor: T0 + 500, fromFile: true });
    assert.deepEqual(earlyCursor.next.joined, [['d.png', iso(T0 + 500)]]);
    const silent = check({ members, chat, cursor: T0 + 9000, fromFile: true });
    assert.deepEqual(silent.next.joined, [['d.png', iso(T0 + 9000)]]);
});

test('stops at the guard', () => {
    assert.deepEqual(check({ cards: new Set() }), GUARDED);
    assert.deepEqual(check({ members: ['a.png', 'b.png', 'nocard.png'] }), GUARDED);
    assert.deepEqual(check({ cards: new Set(), stored: roster({ v: 2 }) }), GUARDED);
    assert.deepEqual(check({ groupId: null }), GUARDED);
    assert.deepEqual(check({ groupId: undefined }), GUARDED);
    assert.deepEqual(check({ since: '' }), GUARDED);
    assert.deepEqual(check({ since: 'x'.repeat(256) }), GUARDED);
    assert.equal(check({ since: 'x'.repeat(255), stored: undefined }).state, 'fresh');
    assert.equal(check({ cards: ['a.png', 'b.png'] }).state, 'checked');
});

test('writes nothing when a list would pass 2,000 entries', () => {
    const crowd = Array.from({ length: 2001 }, (_, index) => `m${index}.png`);
    const atLimit = crowd.slice(0, 2000);
    assert.deepEqual(check({ stored: undefined, members: crowd, cards: new Set(crowd) }), GUARDED);
    assert.equal(check({ stored: undefined, members: atLimit, cards: new Set(atLimit) }).state, 'fresh');

    const full = roster({ known: atLimit });
    assert.equal(readRoster(full).state, 'valid');
    assert.deepEqual(check({ stored: full, members: crowd, cards: new Set(crowd) }), GUARDED);

    const strangers = crowd.map((avatar, index) => said(avatar, T0 + index));
    assert.deepEqual(check({ stored: undefined, chat: strangers }), GUARDED);
    assert.equal(check({ stored: undefined, chat: strangers.slice(0, 2000) }).state, 'fresh');
});

test('keeps foreign rosters untouched', () => {
    const stored = deepFreeze({ v: 3, group: 'g1', future: true });
    const result = check({ stored, members: ['a.png', 'b.png', 'd.png'] });
    assert.deepEqual(result, { state: 'foreign', next: null, changed: false, joined: [], founded: [],
        returned: [], pruned: [], revealed: [], warning: 'foreign' });
});

test('resets invalid ones with a warning', () => {
    const stored = roster({ known: ['a.png', 'a.png'], joined: [['a.png', iso(T0)]] });
    const result = check({ stored: deepFreeze(stored), members: ['a.png', 'b.png', 'd.png'] });
    assert.equal(result.state, 'fresh');
    assert.equal(result.warning, 'invalid');
    assert.equal(result.changed, true);
    assert.deepEqual(result.next.known, ['a.png', 'b.png', 'd.png']);
    assert.deepEqual(result.next.joined, []);
    assert.deepEqual(result.joined, []);
    assert.equal(check({ stored: undefined }).warning, null);
});

test('applies pending reveals', () => {
    const stored = roster({ known: ['a.png', 'b.png', 'd.png'], joined: [['d.png', iso(T0)]] });
    const result = check({ stored: deepFreeze(stored), members: ['a.png', 'b.png', 'd.png'],
        reveals: ['d.png', 'a.png', 'zz.png'] });
    assert.equal(result.changed, true);
    assert.deepEqual(result.revealed, ['d.png']);
    assert.deepEqual(result.next.known, ['a.png', 'b.png', 'd.png']);
    assert.deepEqual(result.next.joined, []);

    const rejoined = check({ members: ['a.png', 'b.png', 'd.png'], reveals: ['d.png'] });
    assert.deepEqual(rejoined.revealed, ['d.png']);
    assert.deepEqual(rejoined.joined, []);
    assert.deepEqual(rejoined.founded, []);
    assert.deepEqual(rejoined.next.joined, []);
});

test('reports no change when content is equal', () => {
    const stored = { v: 1, group: 'g1', since: 'T1', floor: { odd: true }, known: ['d.png', 'b.png', 'a.png'],
        gone: ['z.png'], joined: [['d.png', iso(T0)]], note: 'from a newer build' };
    const result = check({ stored: deepFreeze(stored), members: ['a.png', 'b.png', 'd.png'] });
    assert.equal(result.state, 'checked');
    assert.equal(result.changed, false);
    assert.equal(Object.hasOwn(result.next, 'note'), false);
    assert.equal(result.next.floor, stored.floor);
    assert.deepEqual(result.next.known, ['a.png', 'b.png', 'd.png']);
    const overlap = check({ stored: roster({ gone: ['b.png', 'z.png'] }) });
    assert.equal(overlap.changed, false);
    assert.deepEqual(overlap.next.gone, ['z.png']);
});

test('clamps joins down, never up', () => {
    const joinedAt = roster({ known: ['a.png', 'b.png', 'd.png'], joined: [['d.png', iso(CURSOR)]] });
    assert.equal(clampJoins(joinedAt, CURSOR + 1), joinedAt);
    assert.equal(clampJoins(joinedAt, Number.NaN), joinedAt);
    assert.deepEqual(clampJoins(joinedAt, CURSOR).joined, [['d.png', iso(CURSOR - 1)]]);
    const lowered = clampJoins(deepFreeze(joinedAt), CURSOR - 5000);
    assert.notEqual(lowered, joinedAt);
    assert.deepEqual(lowered, { ...joinedAt, joined: [['d.png', iso(CURSOR - 5001)]] });
    assert.deepEqual(joinedAt.joined, [['d.png', iso(CURSOR)]]);
});

test('removeJoin keeps the member known', () => {
    const joinedAt = deepFreeze(roster({ known: ['a.png', 'b.png', 'd.png'], joined: [['d.png', iso(T0)]] }));
    const shown = removeJoin(joinedAt, 'd.png');
    assert.deepEqual(shown, { ...joinedAt, joined: [] });
    assert.equal(removeJoin(joinedAt, 'a.png'), joinedAt);
});

test('renames in known, gone and joined', () => {
    const before = deepFreeze(roster({ known: ['a.png', 'b.png', 'd.png'], gone: ['z.png'],
        joined: [['d.png', iso(T0)]] }));
    assert.deepEqual(renameInRoster(before, 'd.png', 'dee.png'), { ...before,
        known: ['a.png', 'b.png', 'dee.png'], joined: [['dee.png', iso(T0)]] });
    assert.deepEqual(renameInRoster(before, 'a.png', '0.png'), { ...before, known: ['0.png', 'b.png', 'd.png'] });
    assert.deepEqual(renameInRoster(before, 'z.png', 'y.png'), { ...before, gone: ['y.png'] });
    assert.equal(renameInRoster(before, 'nobody.png', 'x.png'), before);
    assert.equal(renameInRoster(before, 'd.png', 'd.png'), before);
});

test('a rename merge with a founder leaves no join', () => {
    const before = roster({ known: ['a.png', 'b.png', 'd.png'], gone: ['z.png'], joined: [['d.png', iso(T0)]] });
    assert.deepEqual(renameInRoster(before, 'd.png', 'a.png'), { ...before, known: ['a.png', 'b.png'], joined: [] });
    assert.deepEqual(renameInRoster(before, 'a.png', 'd.png'), { ...before, known: ['b.png', 'd.png'], joined: [] });
    assert.deepEqual(renameInRoster(before, 'd.png', 'z.png'), { ...before, known: ['a.png', 'b.png', 'z.png'],
        gone: [], joined: [] });
});

test('a rename merge of two joins keeps the earlier', () => {
    const before = roster({ known: ['a.png', 'd.png', 'e.png'], joined: [['d.png', iso(T0 + 5000)], ['e.png', iso(T0)]] });
    assert.deepEqual(renameInRoster(before, 'd.png', 'e.png').joined, [['e.png', iso(T0)]]);
    assert.deepEqual(renameInRoster(before, 'e.png', 'd.png').joined, [['d.png', iso(T0)]]);
});

test('joinWindowFor gives ms for joiners and undefined for founders', () => {
    const joinedAt = roster({ known: ['a.png', 'b.png', 'd.png'], floor: iso(T0 + 999999), joined: [['d.png', iso(CURSOR)]] });
    assert.equal(joinWindowFor(joinedAt, 'd.png'), CURSOR);
    assert.equal(joinWindowFor(joinedAt, 'a.png'), undefined);
    assert.equal(joinWindowFor(joinedAt, 'stranger.png'), undefined);
    assert.equal(joinWindowFor(null, 'd.png'), undefined);
});

test('reads, adds and drops reveal pairs per chat', () => {
    const k1 = JSON.stringify(['g1', 'chat-1']);
    const k2 = JSON.stringify(['g1', 'chat-2']);
    assert.deepEqual(addRevealPair(null, k1, 'd.png'), [[k1, 'd.png']]);
    const pairs = deepFreeze([[k1, 'd.png'], [k2, 'd.png'], [k1, 'e.png'], 'junk', [k1]]);
    assert.deepEqual(revealsFor(pairs, k1), ['d.png', 'e.png']);
    assert.deepEqual(revealsFor(pairs, 'other'), []);
    assert.deepEqual(revealsFor(null, k1), []);
    assert.deepEqual(addRevealPair(pairs, k1, 'd.png'), [[k2, 'd.png'], [k1, 'e.png'], [k1, 'd.png']]);
    assert.deepEqual(dropRevealPair(pairs, k1, 'd.png'), [[k2, 'd.png'], [k1, 'e.png']]);
    assert.equal(dropRevealPair(pairs, k1, 'f.png'), pairs);
    assert.equal(dropRevealPair(null, k1, 'f.png'), null);
    assert.equal(addRevealPair(pairs, '', 'd.png'), pairs);
    assert.equal(addRevealPair(pairs, k1, ''), pairs);
});

test('keeps at most 500 reveal pairs, dropping the oldest', () => {
    let pairs = null;
    for (let index = 0; index < 501; index++) pairs = addRevealPair(pairs, `chat-${index}`, 'd.png');
    assert.equal(pairs.length, 500);
    assert.deepEqual(pairs[0], ['chat-1', 'd.png']);
    assert.deepEqual(pairs[499], ['chat-500', 'd.png']);
    assert.deepEqual(revealsFor(pairs, 'chat-0'), []);
});

test('treats odd avatars as exact strings', () => {
    const odd = ['__proto__', 'constructor', 'Zoë Ünal.png', '雪 花.png'];
    const result = check({ members: ['a.png', 'b.png', ...odd], cards: new Set(['a.png', 'b.png', ...odd]),
        reveals: ['toString'] });
    assert.deepEqual(result.joined, ['Zoë Ünal.png', '__proto__', 'constructor', '雪 花.png']);
    assert.deepEqual(result.next.known, ['Zoë Ünal.png', '__proto__', 'a.png', 'b.png', 'constructor', '雪 花.png']);
    assert.equal(joinWindowFor(result.next, '__proto__'), CURSOR);
    assert.equal(joinWindowFor(result.next, 'constructor'), CURSOR);
    assert.equal(joinWindowFor(result.next, 'toString'), undefined);
    assert.equal(joinWindowFor(result.next, 'hasOwnProperty'), undefined);
    assert.deepEqual(readRoster(JSON.parse(JSON.stringify(result.next))).roster, result.next);

    const revealed = check({ stored: result.next, members: ['a.png', 'b.png', ...odd],
        cards: new Set(['a.png', 'b.png', ...odd]), reveals: ['__proto__'] });
    assert.deepEqual(revealed.revealed, ['__proto__']);
    assert.equal(joinWindowFor(revealed.next, '__proto__'), undefined);
    assert.equal(Object.getPrototypeOf(revealed.next), Object.prototype);

    const renamed = renameInRoster(result.next, '__proto__', 'hasOwnProperty');
    assert.equal(joinWindowFor(renamed, 'hasOwnProperty'), CURSOR);
    assert.equal(joinWindowFor(renamed, '__proto__'), undefined);
    assert.deepEqual(revealsFor(addRevealPair(null, '__proto__', 'constructor'), '__proto__'), ['constructor']);

    const authors = [said('__proto__', T0), said('constructor', T0 + 1000)];
    const fresh = check({ stored: undefined, chat: authors, cards: new Set(['a.png', 'b.png', '__proto__']) });
    assert.deepEqual(fresh.next.known, ['__proto__', 'a.png', 'b.png']);
    assert.deepEqual(fresh.next.gone, ['constructor']);
});
