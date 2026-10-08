import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    HIDE_TYPES,
    RECORD_KEY,
    absentAfter,
    authorOf,
    blankItems,
    computeAway,
    countHidden,
    emptyRecord,
    latestChanges,
    planHidden,
    readRecord,
    resolveChange,
    revealWalk,
    seedFrom,
    stripRecord,
    writeRecord,
} from '../src/scene-history.js';

const timeOf = value => typeof value === 'number' ? value : Date.parse(value);
const joinTime = Date.parse('2026-10-01T12:00:00Z');

/** A character line; `record` becomes a v1 note when given. */
function line(avatar, mes, record, send_date = '2026-10-01T09:00:00Z') {
    return { name: avatar.replace(/\.png$/u, ''), mes, is_user: false, original_avatar: avatar, send_date,
        extra: record ? { sbu_scene: { v: 1, ...record } } : {} };
}

const invalid = { record: null, invalid: true };
const readStored = value => readRecord({ sbu_scene: value });

test('exports the record key and the filtered prompt types', () => {
    assert.equal(RECORD_KEY, 'sbu_scene');
    assert.deepEqual([...HIDE_TYPES].sort(), ['continue', 'normal', 'swipe']);
});

test('blankItems keeps the length, never touches live extra and is idempotent', () => {
    const IGNORE = Symbol('ignore');
    const live = { mes: 'secret', name: 'Alice', is_user: false, original_avatar: 'alice.png',
        extra: { sbu_scene: { v: 1, away: ['bob.png'] } } };
    const items = [{ ...live }, { mes: 'kept', extra: {} }];
    const plan = planHidden(items, { speaker: 'bob.png', type: 'normal' });
    assert.deepEqual(plan, ['away', null]);
    assert.equal(blankItems(items, plan, IGNORE), 1);
    assert.equal(items.length, 2);
    assert.equal(items[0].mes, '');
    assert.equal(items[0].extra[IGNORE], true);
    assert.equal(live.extra[IGNORE], undefined);
    const once = items[0];
    blankItems(items, plan, IGNORE);
    assert.deepEqual(items[0], once);
});

test('blankItems builds the documented replacement and leaves kept items as they were', () => {
    const IGNORE = Symbol('ignore');
    const kept = { mes: 'kept', name: 'Carol', extra: {} };
    const items = [
        { mes: 'hi', name: 'You', is_user: true, agentContributions: ['x'], send_date: 5, extra: { reasoning: 'r' } },
        kept,
        { mes: 'no extra', name: 'Alice' },
    ];
    assert.equal(blankItems(items, ['away', null, 'joined'], IGNORE), 2);
    assert.deepEqual(items[0], { mes: '', name: '', is_user: false, agentContributions: undefined, send_date: 5,
        extra: { reasoning: 'r', [IGNORE]: true } });
    assert.ok(Object.hasOwn(items[0], 'agentContributions'));
    assert.equal(items[1], kept);
    assert.deepEqual(items[2].extra, { [IGNORE]: true });
    assert.equal(blankItems(items, [null, null, null], IGNORE), 0);
});

test('blankItems assigns nothing when building a replacement throws', () => {
    const IGNORE = Symbol('ignore');
    const first = { mes: 'one', name: 'Alice', extra: {} };
    const broken = { mes: 'two', name: 'Alice' };
    Object.defineProperty(broken, 'extra', { enumerable: true, get() { throw new Error('extension getter'); } });
    const items = [first, broken];
    assert.throws(() => blankItems(items, ['away', 'away'], IGNORE), /extension getter/u);
    assert.equal(items[0], first);
    assert.equal(items[1], broken);
    assert.equal(first.mes, 'one');
});

test('reads a valid record and normalises missing lists', () => {
    assert.deepEqual(readRecord({}), { record: null, invalid: false });
    assert.deepEqual(readRecord({ other: 1 }), { record: null, invalid: false });
    assert.deepEqual(readStored({ v: 1 }), { record: { away: [], moved: [], undone: [] }, invalid: false });
    assert.deepEqual(readStored({ v: 1, away: ['bob.png'], moved: [['alice.png', 'absent', 'present']], undone: ['carol.png'] }),
        { record: { away: ['bob.png'], moved: [['alice.png', 'absent', 'present']], undone: ['carol.png'] }, invalid: false });
    for (const entry of [['a', 'absent', 'present'], ['a', 'remote', 'present'], ['a', 'present', 'absent'], ['a', 'unspecified', 'absent']]) {
        assert.equal(readStored({ v: 1, moved: [entry] }).invalid, false, entry.join(' '));
    }
});

test('returns copies, so editing a read record never changes the stored one', () => {
    const stored = { v: 1, away: ['bob.png'], moved: [['alice.png', 'absent', 'present']] };
    const { record } = readStored(stored);
    record.away.push('carol.png');
    record.moved[0][2] = 'absent';
    assert.deepEqual(stored, { v: 1, away: ['bob.png'], moved: [['alice.png', 'absent', 'present']] });
});

test('rejects forged and oversized records', () => {
    const long = 'a'.repeat(256);
    const many = Array.from({ length: 65 }, (_, index) => `member-${index}.png`);
    assert.deepEqual(readStored({ v: 2, away: ['bob.png'] }), invalid);
    assert.deepEqual(readStored({ away: ['bob.png'] }), invalid);
    assert.deepEqual(readStored({ v: '1', away: ['bob.png'] }), invalid);
    assert.deepEqual(readStored({ v: 1, away: 'bob.png' }), invalid);
    assert.deepEqual(readStored({ v: 1, away: [''] }), invalid);
    assert.deepEqual(readStored({ v: 1, away: [long] }), invalid);
    assert.deepEqual(readStored({ v: 1, away: [42] }), invalid);
    assert.deepEqual(readStored({ v: 1, away: many }), invalid);
    assert.deepEqual(readStored({ v: 1, undone: many }), invalid);
    assert.deepEqual(readStored({ v: 1, away: [] }), invalid);
    assert.deepEqual(readStored({ v: 1, away: null }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: [['a', 'present', 'present']] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: [['a', 'remote', 'absent']] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: [['a', 'absent', 'absent']] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: [['a', 'unspecified', 'present']] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: [['a', 'present', 'remote']] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: [['', 'present', 'absent']] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: [['a', 'present']] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: [['a', 'present', 'absent', 'extra']] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: ['a'] }), invalid);
    assert.deepEqual(readStored({ v: 1, moved: many.map(avatar => [avatar, 'present', 'absent']) }), invalid);
    assert.deepEqual(readStored(null), invalid);
    assert.deepEqual(readStored('note'), invalid);
    assert.deepEqual(readStored([1]), invalid);
    assert.equal(readStored({ v: 1, away: ['a'.repeat(255)] }).invalid, false);
    assert.equal(readStored({ v: 1, away: many.slice(0, 64) }).invalid, false);
    assert.deepEqual(readStored({ v: 1, away: ['bob.png'], note: 'ignored', moved: undefined }),
        { record: { away: ['bob.png'], moved: [], undone: [] }, invalid: false });
});

test('writes and deletes on extra and the shown swipe entry, replacing the object', () => {
    const message = { mes: 'two', swipe_id: 1, extra: { reasoning: 'r' },
        swipe_info: [{ extra: { reasoning: 'old' } }, { send_date: 'now' }] };
    const rec = { away: ['bob.png'], moved: [], undone: [] };
    writeRecord(message, rec);
    assert.deepEqual(message.extra, { reasoning: 'r', sbu_scene: { v: 1, away: ['bob.png'] } });
    assert.deepEqual(message.swipe_info[1].extra, { sbu_scene: { v: 1, away: ['bob.png'] } });
    assert.deepEqual(message.swipe_info[0].extra, { reasoning: 'old' });
    rec.away.push('carol.png');
    assert.deepEqual(message.extra.sbu_scene.away, ['bob.png']);

    const first = message.extra.sbu_scene;
    const mirrored = message.swipe_info[1].extra.sbu_scene;
    writeRecord(message, { away: ['bob.png'], moved: [['carol.png', 'present', 'absent']], undone: ['dave.png'] });
    const expected = { v: 1, away: ['bob.png'], moved: [['carol.png', 'present', 'absent']], undone: ['dave.png'] };
    assert.notEqual(message.extra.sbu_scene, first);
    assert.notEqual(message.swipe_info[1].extra.sbu_scene, mirrored);
    assert.deepEqual(first, { v: 1, away: ['bob.png'] });
    assert.deepEqual(message.extra.sbu_scene, expected);
    assert.deepEqual(message.swipe_info[1].extra.sbu_scene, expected);

    const same = { away: ['bob.png'], moved: [], undone: [] };
    writeRecord(message, same);
    const written = message.extra.sbu_scene;
    writeRecord(message, same);
    assert.notEqual(message.extra.sbu_scene, written);
    assert.deepEqual(message.extra.sbu_scene, written);

    writeRecord(message, { away: [], moved: [], undone: [] });
    assert.equal(Object.hasOwn(message.extra, 'sbu_scene'), false);
    assert.equal(Object.hasOwn(message.swipe_info[1].extra, 'sbu_scene'), false);
    assert.equal(message.extra.reasoning, 'r');

    const bare = { mes: 'x' };
    writeRecord(bare, { away: ['bob.png'] });
    assert.deepEqual(bare, { mes: 'x', extra: { sbu_scene: { v: 1, away: ['bob.png'] } } });
    writeRecord(bare, null);
    assert.deepEqual(bare.extra, {});

    const pastEnd = { mes: 'y', swipe_id: 3, swipe_info: [{}], extra: {} };
    writeRecord(pastEnd, { away: ['bob.png'] });
    assert.deepEqual(pastEnd.swipe_info, [{}]);
    assert.deepEqual(pastEnd.extra.sbu_scene, { v: 1, away: ['bob.png'] });
});

test('writes away and undone sorted and unique', () => {
    const message = { extra: {} };
    writeRecord(message, { away: ['dave.png', 'bob.png', 'dave.png'], moved: [], undone: ['carol.png', 'alice.png', 'carol.png'] });
    assert.deepEqual(message.extra.sbu_scene, { v: 1, away: ['bob.png', 'dave.png'], undone: ['alice.png', 'carol.png'] });
});

test('knows when a record is empty', () => {
    assert.equal(emptyRecord(null), true);
    assert.equal(emptyRecord({ away: [], moved: [], undone: [] }), true);
    assert.equal(emptyRecord({ away: ['bob.png'], moved: [], undone: [] }), false);
    assert.equal(emptyRecord({ away: [], moved: [['bob.png', 'present', 'absent']], undone: [] }), false);
    assert.equal(emptyRecord({ away: [], moved: [], undone: ['bob.png'] }), false);
});

test('strips copies from alternatives without touching the shown version', () => {
    const shown = { reasoning: 'r', sbu_scene: { v: 1, away: ['bob.png'] } };
    const message = { extra: shown, swipe_id: 0, swipe_info: [{ extra: shown }, { extra: shown }, { extra: { ...shown } }] };
    stripRecord(message.swipe_info[1]);
    stripRecord(message.swipe_info[2]);
    assert.deepEqual(message.swipe_info[1].extra, { reasoning: 'r' });
    assert.deepEqual(message.swipe_info[2].extra, { reasoning: 'r' });
    assert.equal(message.extra, shown);
    assert.deepEqual(shown, { reasoning: 'r', sbu_scene: { v: 1, away: ['bob.png'] } });
    assert.equal(message.swipe_info[0].extra, shown);

    const plain = { extra: { reasoning: 'r' } };
    const before = plain.extra;
    stripRecord(plain);
    assert.equal(plain.extra, before);
    assert.doesNotThrow(() => { stripRecord({}); stripRecord(null); stripRecord({ extra: 'text' }); });
});

test('finds the author of character lines only', () => {
    assert.equal(authorOf({ original_avatar: 'alice.png', is_user: false }), 'alice.png');
    assert.equal(authorOf({ original_avatar: 'alice.png', is_user: true }), undefined);
    assert.equal(authorOf({ original_avatar: 'alice.png', extra: { type: 'narrator' } }), undefined);
    assert.equal(authorOf({ original_avatar: '' }), undefined);
    assert.equal(authorOf({ original_avatar: 7 }), undefined);
    assert.equal(authorOf({}), undefined);
    assert.equal(authorOf(null), undefined);
});

test('moves only members whose status changes', () => {
    assert.equal(resolveChange('absent', 'absent'), null);
    assert.equal(resolveChange('remote', 'absent'), null);
    assert.equal(resolveChange('unspecified', 'present'), null);
    assert.equal(resolveChange('present', 'present'), null);
    assert.equal(resolveChange('present', 'remote'), null);
    assert.equal(resolveChange(undefined, 'absent'), null);
    assert.deepEqual(resolveChange('remote', 'present'), { from: 'remote', to: 'present' });
    assert.deepEqual(resolveChange('absent', 'present'), { from: 'absent', to: 'present' });
    assert.deepEqual(resolveChange('present', 'absent'), { from: 'present', to: 'absent' });
    assert.deepEqual(resolveChange('unspecified', 'absent'), { from: 'unspecified', to: 'absent' });
});

test('applies the union rule', () => {
    assert.deepEqual(computeAway({ absentAt: ['bob.png', 'carol.png'], movers: ['carol.png'], author: 'bob.png' }), []);
    assert.deepEqual(computeAway({ absentAt: ['dave.png', 'bob.png'], movers: [], author: 'alice.png' }), ['bob.png', 'dave.png']);
    assert.deepEqual(computeAway({ absentAt: new Set(['dave.png', 'bob.png']), movers: new Set(), author: undefined }),
        ['bob.png', 'dave.png']);
    assert.deepEqual(computeAway({ absentAt: ['bob.png', 'bob.png'], movers: [] }), ['bob.png']);
});

test('lists who is absent after a line', () => {
    assert.deepEqual(absentAfter({ away: ['dave.png', 'bob.png'], undone: [],
        moved: [['carol.png', 'present', 'absent'], ['dave.png', 'absent', 'present']] }), ['bob.png', 'carol.png']);
    assert.deepEqual(absentAfter({ away: [], moved: [], undone: [] }), []);
    assert.deepEqual(absentAfter(null), []);
});

test('indexes each member\'s latest change', () => {
    const chat = [
        line('alice.png', 'zero'),
        { ...line('alice.png', 'one', { moved: [['carol.png', 'present', 'absent']] }), is_system: true },
        line('alice.png', 'two', { moved: [['bob.png', 'present', 'absent']] }),
        line('alice.png', 'three', { away: ['bob.png'] }),
        { ...line('bob.png', 'four', { moved: [['bob.png', 'present', 'absent'], ['bob.png', 'absent', 'present']] }), swipe_id: 2 },
        line('alice.png', 'forged', { v: 2, moved: [['carol.png', 'absent', 'present']] }),
    ];
    const index = latestChanges(chat);
    assert.deepEqual([...index.keys()].sort(), ['bob.png', 'carol.png']);
    const bob = index.get('bob.png');
    assert.equal(bob.index, 4);
    assert.equal(bob.message, chat[4]);
    assert.equal(bob.swipeId, 2);
    assert.deepEqual(bob.entry, ['bob.png', 'absent', 'present']);
    assert.equal(index.get('carol.png').index, 1);
    assert.deepEqual(index.get('carol.png').entry, ['carol.png', 'present', 'absent']);
    assert.equal(latestChanges([]).size, 0);
});

test('reveal walk skips own and system lines and stops at the first other line', () => {
    const chat = [
        line('alice.png', 'zero', { away: ['bob.png'] }),
        line('alice.png', 'one'),
        line('alice.png', 'two'),
        line('alice.png', 'three'),
        line('alice.png', 'four'),
        line('alice.png', 'five', { away: ['bob.png'] }),
        line('bob.png', 'six'),
        { ...line('alice.png', 'seven'), is_system: true },
        line('carol.png', 'eight', { away: ['bob.png', 'dave.png'] }),
    ];
    assert.deepEqual(revealWalk(chat, 'bob.png'), [8, 5]);
    assert.deepEqual(revealWalk(chat, 'dave.png'), [8]);
    assert.deepEqual(revealWalk(chat, 'erin.png'), []);

    const recordedSystem = [
        line('alice.png', 'zero', { away: ['bob.png'] }),
        { ...line('alice.png', 'hidden', { away: ['carol.png'] }), is_system: true },
        line('alice.png', 'two', { away: ['bob.png'] }),
    ];
    assert.deepEqual(revealWalk(recordedSystem, 'bob.png'), [2]);
});

test('seeds from the newest recorded line', () => {
    const chat = [
        line('alice.png', 'zero', { away: ['erin.png'] }),
        line('alice.png', 'one', { away: ['bob.png'],
            moved: [['carol.png', 'present', 'absent'], ['dave.png', 'absent', 'present']] }),
        { ...line('alice.png', 'hidden', { away: ['erin.png'] }), is_system: true },
    ];
    assert.deepEqual(seedFrom(chat), ['bob.png', 'carol.png']);
    assert.deepEqual(seedFrom([line('alice.png', 'back', { moved: [['bob.png', 'absent', 'present']] })]), []);
    assert.equal(seedFrom([...chat, line('alice.png', 'unrecorded')]), null);
    assert.equal(seedFrom([line('alice.png', 'forged', { v: 2, away: ['bob.png'] })]), null);
    assert.equal(seedFrom([line('alice.png', 'plain')]), null);
    assert.equal(seedFrom([]), null);
});

test('gates by type, omniscience, continue target and author', () => {
    const items = [
        line('alice.png', 'a', { away: ['bob.png'] }),
        line('bob.png', 'own', { away: ['bob.png'] }),
        { ...line('bob.png', 'typed as user', { away: ['bob.png'] }), is_user: true },
        { ...line('bob.png', 'narrated'), extra: { type: 'narrator', sbu_scene: { v: 1, away: ['bob.png'] } } },
        line('carol.png', 'c', { away: ['bob.png'] }),
    ];
    const hidden = ['away', null, 'away', 'away', 'away'];
    assert.deepEqual(planHidden(items, { speaker: 'bob.png', type: 'normal' }), hidden);
    assert.deepEqual(planHidden(items, { speaker: 'bob.png', type: 'swipe' }), hidden);
    assert.deepEqual(planHidden(items, { speaker: 'bob.png', type: 'continue' }), ['away', null, 'away', 'away', null]);
    const none = [null, null, null, null, null];
    for (const type of ['quiet', 'impersonate', 'regenerate', undefined]) {
        assert.deepEqual(planHidden(items, { speaker: 'bob.png', type, joinTime, timeOf }), none, String(type));
    }
    assert.deepEqual(planHidden(items, { speaker: 'bob.png', type: 'normal', omniscient: true, joinTime, timeOf }), none);
    assert.deepEqual(planHidden(items, { speaker: undefined, type: 'normal' }), none);
    assert.deepEqual(planHidden(items, { speaker: '', type: 'normal', joinTime, timeOf }), none);
    assert.deepEqual(planHidden(items, { speaker: 'alice.png', type: 'normal' }), none);
});

test('hides by join time with or without a record', () => {
    const items = [
        line('alice.png', 'before', undefined, '2026-10-01T11:00:00Z'),
        line('alice.png', 'at', { away: ['carol.png'] }, joinTime),
        line('alice.png', 'after', undefined, '2026-10-01T13:00:00Z'),
        line('alice.png', 'unreadable', undefined, 'yesterday-ish'),
        line('dave.png', 'own', undefined, '2026-10-01T10:00:00Z'),
    ];
    assert.deepEqual(planHidden(items, { speaker: 'dave.png', type: 'normal', joinTime, timeOf }),
        ['joined', 'joined', null, null, null]);

    const both = [line('alice.png', 'both', { away: ['dave.png'] }, '2026-10-01T11:00:00Z'),
        line('alice.png', 'target', undefined, '2026-10-01T11:30:00Z')];
    assert.deepEqual(planHidden(both, { speaker: 'dave.png', type: 'normal', joinTime, timeOf }), ['away', 'joined']);
    assert.deepEqual(planHidden(both, { speaker: 'dave.png', type: 'continue', joinTime, timeOf }), ['away', null]);
    assert.deepEqual(planHidden([{ mes: 'no date', extra: {} }], { speaker: 'dave.png', type: 'normal', joinTime, timeOf }), [null]);
});

test('parses dates only when the speaker has a join time', () => {
    const items = [line('alice.png', 'a'), line('alice.png', 'b', { away: ['dave.png'] })];
    const refuse = () => { throw new Error('parsed a date'); };
    assert.deepEqual(planHidden(items, { speaker: 'dave.png', type: 'normal', timeOf: refuse }), [null, 'away']);
    assert.deepEqual(planHidden(items, { speaker: 'dave.png', type: 'normal', joinTime: undefined, timeOf: refuse }),
        [null, 'away']);
    const seen = [];
    planHidden(items, { speaker: 'dave.png', type: 'normal', joinTime, timeOf: value => { seen.push(value); return timeOf(value); } });
    assert.deepEqual(seen, [items[0].send_date]);
});

test('counts agree with the plan and skip system lines', () => {
    const chat = [
        line('alice.png', 'zero', undefined, '2026-10-01T10:00:00Z'),
        { ...line('alice.png', 'hidden', { away: ['dave.png'] }, '2026-10-01T10:30:00Z'), is_system: true },
        line('alice.png', 'two', { away: ['dave.png'] }, '2026-10-01T11:00:00Z'),
        line('dave.png', 'own', undefined, '2026-10-01T11:30:00Z'),
        line('alice.png', 'four', { away: ['dave.png'] }, '2026-10-01T13:00:00Z'),
        line('alice.png', 'five', undefined, '2026-10-01T14:00:00Z'),
    ];
    const options = { speaker: 'dave.png', joinTime, timeOf };
    const counts = countHidden(chat, options);
    assert.deepEqual(counts, { away: 2, joined: 1,
        lines: [{ index: 0, rule: 'joined' }, { index: 2, rule: 'away' }, { index: 4, rule: 'away' }] });

    const items = chat.filter(message => !message.is_system).map(message => ({ ...message }));
    const plan = planHidden(items, { ...options, type: 'normal' });
    assert.equal(plan.filter(rule => rule === 'away').length, counts.away);
    assert.equal(plan.filter(rule => rule === 'joined').length, counts.joined);
    assert.equal(blankItems(items, plan, Symbol('ignore')), counts.lines.length);

    assert.deepEqual(countHidden(chat, { ...options, type: 'quiet' }), counts);
    assert.deepEqual(countHidden(chat, { ...options, omniscient: true }), { away: 0, joined: 0, lines: [] });
    assert.deepEqual(countHidden(chat, { speaker: 'carol.png' }), { away: 0, joined: 0, lines: [] });
});

test('tolerates unusual messages', () => {
    const odd = [
        { mes: 42, swipe_id: 9, swipe_info: [] },
        { mes: null, extra: null, swipe_info: null, swipe_id: 0 },
        { mes: 'x', extra: 'text', swipe_info: [null, 'entry'], swipe_id: 1 },
        { mes: 'x', extra: { sbu_scene: 'note' }, swipe_info: [{ extra: {} }], swipe_id: '__proto__' },
        { mes: 'x', extra: { type: 'narrator' }, swipe_info: { 0: { extra: {} } }, swipe_id: 0 },
        null,
        'string line',
    ];
    assert.deepEqual(readRecord(undefined), { record: null, invalid: false });
    assert.deepEqual(readRecord(null), { record: null, invalid: false });
    assert.deepEqual(readRecord('extra'), { record: null, invalid: false });
    assert.doesNotThrow(() => {
        for (const message of odd) {
            authorOf(message);
            stripRecord(message);
            readRecord(message?.extra);
        }
    });
    assert.equal(latestChanges(odd).size, 0);
    assert.deepEqual(revealWalk(odd, 'bob.png'), []);
    assert.equal(seedFrom(odd), null);
    assert.deepEqual(planHidden(odd, { speaker: 'bob.png', type: 'normal', joinTime, timeOf }), odd.map(() => null));
    assert.deepEqual(countHidden(odd, { speaker: 'bob.png', joinTime, timeOf }), { away: 0, joined: 0, lines: [] });
    assert.equal(blankItems([...odd], odd.map(() => 'away'), Symbol('ignore')), 5);
    assert.equal(latestChanges(undefined).size, 0);
    assert.deepEqual(revealWalk(undefined, 'bob.png'), []);
    assert.equal(seedFrom(undefined), null);
    assert.deepEqual(countHidden(undefined, { speaker: 'bob.png' }), { away: 0, joined: 0, lines: [] });

    const copies = odd.slice(0, 5).map(message => JSON.parse(JSON.stringify(message)));
    assert.doesNotThrow(() => { for (const message of copies) writeRecord(message, { away: ['bob.png'] }); });
    assert.deepEqual(copies[0].extra, { sbu_scene: { v: 1, away: ['bob.png'] } });
    assert.deepEqual(copies[0].swipe_info, []);
    assert.deepEqual(copies[2].swipe_info, [null, 'entry']);
    assert.deepEqual(copies[3].swipe_info, [{ extra: {} }]);
    assert.deepEqual(copies[4].swipe_info, { 0: { extra: {} } });
    assert.equal(Object.hasOwn(Array.prototype, 'extra'), false);
    assert.equal(Object.hasOwn(Object.prototype, 'sbu_scene'), false);
    assert.doesNotThrow(() => { writeRecord(null, { away: ['bob.png'] }); writeRecord('line', { away: ['bob.png'] }); });
});

test('plans 5000 items quickly', () => {
    const IGNORE = Symbol('ignore');
    const start = Date.parse('2026-01-01T00:00:00Z');
    const items = Array.from({ length: 5000 }, (_, index) => ({
        name: index % 3 === 0 ? 'You' : 'Alice', mes: `line ${index}`, is_user: index % 3 === 0,
        original_avatar: 'alice.png', send_date: new Date(start + index * 60000).toISOString(),
        extra: index % 7 === 0 ? { sbu_scene: { v: 1, away: ['dave.png', 'erin.png'] } } : {},
    }));
    const join = start + 2500 * 60000;
    const expected = items.filter((_, index) => index <= 2500 || index % 7 === 0).length;
    const began = performance.now();
    const plan = planHidden(items, { speaker: 'dave.png', type: 'normal', joinTime: join, timeOf });
    const count = blankItems(items, plan, IGNORE);
    const elapsed = performance.now() - began;
    assert.equal(count, expected);
    assert.equal(items.length, 5000);
    assert.ok(elapsed < 250, `planning took ${elapsed.toFixed(1)} ms`);
});

test('treats odd avatars as exact strings', () => {
    const odd = ['__proto__', 'constructor', 'toString', 'Zoë Ash.png', ' spaced name .png', '花子.png'];
    const chat = odd.map(avatar => line('alice.png', avatar, { away: [avatar] }));
    for (const [index, avatar] of odd.entries()) {
        const plan = planHidden(chat, { speaker: avatar, type: 'normal' });
        assert.deepEqual(plan, odd.map((_, other) => other === index ? 'away' : null), avatar);
    }
    assert.deepEqual(planHidden(chat, { speaker: 'proto', type: 'normal' }), odd.map(() => null));
    assert.deepEqual(planHidden([line('__proto__', 'own', { away: ['__proto__'] })], { speaker: '__proto__', type: 'normal' }), [null]);
    assert.equal(authorOf({ original_avatar: '__proto__' }), '__proto__');

    const moves = [line('alice.png', 'move', { moved: [['__proto__', 'present', 'absent'], ['constructor', 'absent', 'present']] })];
    const index = latestChanges(moves);
    assert.deepEqual([...index.keys()].sort(), ['__proto__', 'constructor']);
    assert.equal(index.has('toString'), false);
    assert.deepEqual(index.get('__proto__').entry, ['__proto__', 'present', 'absent']);

    assert.deepEqual(computeAway({ absentAt: ['__proto__', 'constructor'], movers: ['constructor'], author: 'toString' }), ['__proto__']);
    assert.deepEqual(absentAfter(readRecord(moves[0].extra).record), ['__proto__']);
    assert.deepEqual(revealWalk(chat, '花子.png'), [5]);
    assert.deepEqual(revealWalk(chat, '__proto__'), []);
    assert.deepEqual(revealWalk([line('alice.png', 'x', { away: ['__proto__'] })], '__proto__'), [0]);

    const message = { extra: {} };
    writeRecord(message, { away: ['__proto__'], moved: [['constructor', 'present', 'absent']], undone: ['__proto__'] });
    assert.deepEqual(readRecord(message.extra).record,
        { away: ['__proto__'], moved: [['constructor', 'present', 'absent']], undone: ['__proto__'] });

    const IGNORE = Symbol('ignore');
    const parsed = JSON.parse('{"mes":"m","extra":{"__proto__":"kept","sbu_scene":{"v":1,"away":["bob.png"]}}}');
    const items = [{ ...parsed }];
    blankItems(items, planHidden(items, { speaker: 'bob.png', type: 'normal' }), IGNORE);
    assert.equal(Object.hasOwn(items[0].extra, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(items[0].extra), Object.prototype);
    stripRecord(parsed);
    assert.equal(Object.hasOwn(parsed.extra, '__proto__'), true);
    assert.equal(Object.hasOwn(parsed.extra, 'sbu_scene'), false);
    assert.equal(Object.getPrototypeOf(parsed.extra), Object.prototype);
});
