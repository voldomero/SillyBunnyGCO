import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    alignMemoryToken,
    defaults,
    ensureSettings,
    foundersSnapshot,
    isOmniscient,
    memoryActive,
    memoryOn,
    omniscientPatch,
    readRevealPairs,
    renameMemorySettings,
    withMemoryToken,
} from '../src/settings.js';

const now = Date.UTC(2026, 9, 8, 1);
const token = '2026-10-08T01:00:00.000Z';
const groups = [{ id: 1759880000000, members: ['a.png', 'b.png', 'a.png', 7] }];
const snapshotAtToken = { since: token, groups: { 1759880000000: ['a.png', 'b.png'] } };
const memoryOnSettings = { scene_controls: true, scene_history: true, scene_history_since: 'T0',
    scene_history_founders: { since: 'T0', groups: {} } };

test('adds the six scene memory keys through ensureSettings', () => {
    const stored = ensureSettings({});
    for (const key of ['scene_history', 'scene_auto', 'scene_omniscient',
        'scene_history_since', 'scene_history_founders', 'scene_join_reveals']) {
        assert.ok(Object.hasOwn(defaults, key), key);
        assert.ok(Object.hasOwn(stored, key), key);
    }
    assert.equal(stored.scene_history, false);
    assert.equal(stored.scene_auto, false);
    assert.equal(stored.scene_history_since, null);
});

test('mints a token and founders snapshot when scene memory turns on', () => {
    const groups = [{ id: 1759880000000, members: ['a.png', 'b.png', 'a.png', 7] }];
    const input = { scene_history: true };
    const patch = withMemoryToken({ scene_controls: true, scene_history: false },
        input, { now: Date.UTC(2026, 9, 8, 1), groups });
    assert.equal(patch.scene_history, true);
    assert.equal(patch.scene_history_since, '2026-10-08T01:00:00.000Z');
    assert.equal(patch.scene_history_founders.since, '2026-10-08T01:00:00.000Z');
    assert.deepEqual(patch.scene_history_founders.groups['1759880000000'], ['a.png', 'b.png']);
    assert.deepEqual(input, { scene_history: true });
    assert.deepEqual(groups[0].members, ['a.png', 'b.png', 'a.png', 7]);
});

test('mints through the scene controls switch too', () => {
    const patch = withMemoryToken({ scene_controls: false, scene_history: true },
        { scene_controls: true }, { now, groups });
    assert.deepEqual(patch, { scene_controls: true, scene_history_since: token,
        scene_history_founders: snapshotAtToken });
});

test('clears token and snapshot when either switch turns memory off', () => {
    assert.deepEqual(withMemoryToken(memoryOnSettings, { scene_history: false }, { now, groups }),
        { scene_history: false, scene_history_since: null, scene_history_founders: null });
    assert.deepEqual(withMemoryToken(memoryOnSettings, { scene_controls: false }, { now, groups }),
        { scene_controls: false, scene_history_since: null, scene_history_founders: null });
});

test('leaves unrelated patches untouched', () => {
    const x = { version: 1, chats: {} };
    const input = { current_scenes: x };
    const result = withMemoryToken(memoryOnSettings, input, { now, groups });
    assert.deepEqual(result, { current_scenes: x });
    assert.notEqual(result, input);
    assert.equal(result.current_scenes, x);
    // A repeated turn-on keeps the existing token; a switch that leaves memory off mints nothing.
    assert.deepEqual(withMemoryToken(memoryOnSettings, { scene_history: true }, { now, groups }),
        { scene_history: true });
    assert.deepEqual(withMemoryToken({ scene_controls: false, scene_history: false },
        { scene_history: true }, { now, groups }), { scene_history: true });
});

test('aligns a replayed switch', () => {
    assert.deepEqual(alignMemoryToken({ scene_controls: true, scene_history: true, scene_history_since: null },
        { now, groups }), { scene_history_since: token, scene_history_founders: snapshotAtToken });
    assert.deepEqual(alignMemoryToken({ scene_controls: false, scene_history: true, scene_history_since: 'x' },
        { now, groups }), { scene_history_since: null, scene_history_founders: null });
    const staleFounders = { scene_controls: true, scene_history: false, scene_history_since: null,
        scene_history_founders: { since: 'x', groups: {} } };
    assert.deepEqual(alignMemoryToken(staleFounders, { now, groups }),
        { scene_history_since: null, scene_history_founders: null });
    assert.equal(alignMemoryToken(memoryOnSettings, { now, groups }), null);
    assert.equal(alignMemoryToken({ ...defaults }, { now, groups }), null);
    // An empty token reads as off (memoryActive), so it is renewed rather than left dead.
    assert.equal(alignMemoryToken({ scene_controls: true, scene_history: true, scene_history_since: '' },
        { now, groups })?.scene_history_since, token);
});

test('tells scene memory on from active', () => {
    assert.equal(memoryOn({ scene_controls: true, scene_history: true }), true);
    assert.equal(memoryOn({ scene_controls: true, scene_history: 'true' }), false);
    assert.equal(memoryOn({ scene_controls: false, scene_history: true }), false);
    assert.equal(memoryOn(null), false);
    assert.equal(memoryActive({ scene_controls: true, scene_history: true, scene_history_since: token }), true);
    assert.equal(memoryActive({ scene_controls: true, scene_history: true, scene_history_since: null }), false);
    assert.equal(memoryActive({ scene_controls: true, scene_history: true, scene_history_since: '' }), false);
    assert.equal(memoryActive({ scene_controls: true, scene_history: false, scene_history_since: token }), false);
});

test('caps each founders group at 2000 members', () => {
    const many = Array.from({ length: 2001 }, (_, index) => `m${index}.png`);
    const snapshot = foundersSnapshot([{ id: 'g1', members: ['m0.png', ...many] },
        { id: 'g2', members: ['x.png'] }], token);
    assert.equal(snapshot.groups.g1.length, 2000);
    assert.equal(snapshot.groups.g1[0], 'm0.png');
    assert.equal(snapshot.groups.g1[1999], 'm1999.png');
    assert.equal(snapshot.groups.g1.includes('m2000.png'), false);
    assert.deepEqual(snapshot.groups.g2, ['x.png']);
});

test('snapshots groups under exact keys and skips unreadable groups', () => {
    const snapshot = foundersSnapshot([
        { id: '__proto__', members: ['a.png'] },
        { id: 'g2', members: 'a.png' },
        null,
        { members: ['b.png'] },
        { id: 'g3', members: ['', null, 'c.png', 'c.png'] },
        { id: 'g3', members: ['d.png'] },
    ], token);
    assert.equal(snapshot.since, token);
    assert.equal(Object.getPrototypeOf(snapshot.groups), Object.prototype);
    assert.deepEqual(Object.keys(snapshot.groups), ['__proto__', 'g3']);
    assert.ok(Object.hasOwn(snapshot.groups, '__proto__'));
    assert.deepEqual(Object.getOwnPropertyDescriptor(snapshot.groups, '__proto__').value, ['a.png']);
    assert.deepEqual(snapshot.groups.g3, ['c.png']);
    assert.deepEqual(foundersSnapshot(undefined, token), { since: token, groups: {} });
});

test('omniscience uses exact avatar keys', () => {
    const patch = omniscientPatch({}, '__proto__', true);
    assert.ok(Object.hasOwn(patch.scene_omniscient, '__proto__'));
    assert.equal(Object.getOwnPropertyDescriptor(patch.scene_omniscient, '__proto__').value, true);
    assert.equal(Object.getPrototypeOf(patch.scene_omniscient), Object.prototype);
    assert.equal(isOmniscient(patch, '__proto__'), true);
    assert.equal(isOmniscient({ scene_omniscient: {} }, 'constructor'), false);
    assert.equal(isOmniscient({ scene_omniscient: { 'a.png': 'yes' } }, 'a.png'), false);
    assert.equal(isOmniscient(null, 'a.png'), false);

    const settings = { scene_omniscient: { 'a.png': true } };
    const both = omniscientPatch(settings, 'constructor', true);
    assert.deepEqual(both, { scene_omniscient: { 'a.png': true, constructor: true } });
    assert.deepEqual(settings, { scene_omniscient: { 'a.png': true } });
    assert.deepEqual(omniscientPatch(both, 'constructor', false), { scene_omniscient: { 'a.png': true } });
    assert.deepEqual(omniscientPatch(patch, '__proto__', false), { scene_omniscient: null });
    assert.deepEqual(omniscientPatch({ scene_omniscient: 'broken' }, 'b.png', true),
        { scene_omniscient: { 'b.png': true } });
});

test('reads only valid reveal pairs, newest 500', () => {
    const settings = { scene_join_reveals: [['k', 'a.png'], ['k'], ['k', ''], [1, 'b.png'], 'k', null,
        ['k', 'b.png', 'extra'], ['k2', '__proto__']] };
    const pairs = readRevealPairs(settings);
    assert.deepEqual(pairs, [['k', 'a.png'], ['k2', '__proto__']]);
    assert.notEqual(pairs[0], settings.scene_join_reveals[0]);
    assert.deepEqual(readRevealPairs({ scene_join_reveals: { k: 'a.png' } }), []);
    assert.deepEqual(readRevealPairs(undefined), []);

    const many = Array.from({ length: 501 }, (_, index) => [`k${index}`, 'a.png']);
    const kept = readRevealPairs({ scene_join_reveals: many });
    assert.equal(kept.length, 500);
    assert.deepEqual(kept[0], ['k1', 'a.png']);
    assert.deepEqual(kept[499], ['k500', 'a.png']);
});

test('renames omniscience, founders and reveal pairs', () => {
    const settings = {
        scene_omniscient: { 'old.png': true, 'c.png': true },
        scene_history_founders: { since: token,
            groups: { g1: ['old.png', 'new.png', 'b.png'], g2: ['b.png', 'old.png'], g3: ['b.png'] } },
        scene_join_reveals: [['k1', 'old.png'], ['k2', 'b.png'], ['k1', 'new.png']],
    };
    const before = structuredClone(settings);
    assert.deepEqual(renameMemorySettings(settings, 'old.png', 'new.png'), {
        scene_omniscient: { 'c.png': true, 'new.png': true },
        scene_history_founders: { since: token,
            groups: { g1: ['new.png', 'b.png'], g2: ['b.png', 'new.png'], g3: ['b.png'] } },
        scene_join_reveals: [['k1', 'new.png'], ['k2', 'b.png']],
    });
    assert.deepEqual(settings, before);
    assert.equal(renameMemorySettings(settings, 'gone.png', 'new.png'), null);
    assert.equal(renameMemorySettings(settings, 'old.png', 'old.png'), null);
    assert.equal(renameMemorySettings(settings, 'old.png', ''), null);

    const odd = renameMemorySettings(omniscientPatch({}, '__proto__', true), '__proto__', 'constructor');
    assert.deepEqual(Object.keys(odd), ['scene_omniscient']);
    assert.ok(Object.hasOwn(odd.scene_omniscient, 'constructor'));
    assert.equal(Object.hasOwn(odd.scene_omniscient, '__proto__'), false);
    assert.equal(Object.getPrototypeOf(odd.scene_omniscient), Object.prototype);
    assert.deepEqual(renameMemorySettings({ scene_join_reveals: [['k', '__proto__']] }, '__proto__', 'x.png'),
        { scene_join_reveals: [['k', 'x.png']] });
});
