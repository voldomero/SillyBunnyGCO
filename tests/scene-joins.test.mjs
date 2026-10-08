import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createJoinTracker } from '../src/scene-joins.js';
import { ROSTER_KEY } from '../src/scene-roster.js';
import { createChatSaver } from '../src/scene-saves.js';
import { createSceneStore } from '../src/scene-state.js';
import { createFakeHost } from './helpers/fake-host.mjs';

const START = Date.UTC(2026, 9, 8, 1, 0, 0);
const TOKEN = '2026-10-08T00:00:00.000Z';
const BEFORE_TOKEN = Date.UTC(2026, 9, 7, 23, 0, 0);
const FOUNDERS = ['alice.png', 'bob.png', 'carol.png'];
const iso = ms => new Date(ms).toISOString();
const nothing = () => ({ changed: false, save: null, announce: [], warning: null });
const storedRoster = (fields = {}) => ({ v: 1, group: 'g1', since: TOKEN, floor: null,
    known: [...FOUNDERS], gone: [], joined: [], ...fields });

async function setup(options = {}) {
    const fake = await createFakeHost(options);
    const scene = createSceneStore(fake);
    const logs = [];
    const log = (...args) => logs.push(args);
    const saver = createChatSaver({ host: fake.host, now: fake.clock.now, log });
    const tracker = createJoinTracker({ host: fake.host, settings: fake.settings, scene, saver, now: fake.clock.now, log });
    return {
        fake, scene, saver, tracker, logs,
        roster: () => fake.context.chatMetadata[ROSTER_KEY],
        key: () => fake.host.activeConversation()?.key,
        reveals: () => fake.settings.get().scene_join_reveals,
    };
}

/** Alice, the user and Bob, one second apart; Bob's line is a second before the fake clock starts. */
function threeLines(fake) {
    return [
        fake.message({ avatar: 'alice.png', mes: 'Hello.', send_date: iso(START - 3000) }),
        fake.message({ is_user: true, mes: 'Hi.', send_date: iso(START - 2000) }),
        fake.message({ avatar: 'bob.png', mes: 'Hey.', send_date: iso(START - 1000) }),
    ];
}

async function openThree(t, metadata) {
    await t.fake.openChat(threeLines(t.fake), metadata);
    return t.tracker.check('CHAT_CHANGED');
}

function switchChat(fake, chatId) {
    fake.context.chatId = chatId;
    fake.group.chat_id = chatId;
}

describe('join tracker', () => {
    test('creates a roster at chat open without saving', async () => {
        const t = await setup();
        assert.deepEqual(await openThree(t), { changed: true, save: null, announce: [], warning: null });
        assert.deepEqual(t.roster(), { v: 1, group: 'g1', since: TOKEN, floor: iso(START - 1000),
            known: FOUNDERS, gone: [], joined: [] });
        assert.deepEqual(t.fake.saves, []);
        assert.equal(t.saver.isLoaded(), true);
        assert.deepEqual(t.tracker.check('CHAT_CHANGED'), nothing());
    });

    test('records a member added in the editor', async () => {
        const t = await setup();
        await openThree(t);
        const opened = structuredClone(t.roster());
        await t.fake.addMember('dave.png');
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'),
            { changed: true, save: 'idle', announce: ['dave.png'], warning: null });
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1000)]]);
        assert.deepEqual(t.roster().known, [...FOUNDERS, 'dave.png']);
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'), nothing());

        // The header never reached the file: the next open finds Dave again at the same time, without a second toast.
        await t.fake.openChat(threeLines(t.fake), { integrity: 'fake-integrity', [ROSTER_KEY]: opened });
        assert.deepEqual(t.tracker.check('CHAT_CHANGED'), { changed: true, save: null, announce: [], warning: null });
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1000)]]);
    });

    test('records a /member-add at the next send with the pre-send cursor', async () => {
        const t = await setup();
        await openThree(t);
        await t.fake.addMember('dave.png', { event: false });
        const id = await t.fake.sendUser('hi');
        assert.deepEqual(t.tracker.check('MESSAGE_SENT', { id }),
            { changed: true, save: 'await', announce: ['dave.png'], warning: null });
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1000)]]);
        await t.fake.addMember('erin.png', { event: false });
        assert.equal(t.tracker.joinTime('erin.png'), START + 1000);
    });

    test('a member added while the chat loads joins at its open', async () => {
        const t = await setup();
        await openThree(t);
        switchChat(t.fake, 'c2');
        t.fake.context.chat = [];
        t.fake.context.chatMetadata = {};
        await t.fake.addMember('dave.png', { event: false });
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'), { changed: true, save: 'idle', announce: [], warning: null });
        assert.equal(await t.saver.save(), false);
        assert.deepEqual(t.fake.saves, []);

        const lines = [t.fake.message({ avatar: 'alice.png', mes: 'Earlier.', send_date: iso(START - 9000) }),
            t.fake.message({ is_user: true, mes: 'Later.', send_date: iso(START - 8000) })];
        await t.fake.openChat(lines, { integrity: 'fake-integrity', [ROSTER_KEY]: storedRoster() });
        assert.deepEqual(t.tracker.check('CHAT_CHANGED'),
            { changed: true, save: null, announce: ['dave.png'], warning: null });
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 8000)]]);
    });

    test('reads the new file when the chat changes without a CHAT_CHANGED check', async () => {
        const t = await setup();
        await openThree(t);
        const id = await t.fake.receive('alice.png', 'Back.');
        t.tracker.check('MESSAGE_RECEIVED', { id, type: 'normal' });

        switchChat(t.fake, 'c2');
        t.fake.context.chat = [t.fake.message({ avatar: 'alice.png', mes: 'Elsewhere.', send_date: iso(START - 9000) })];
        t.fake.context.chatMetadata = { integrity: 'fake-integrity', [ROSTER_KEY]: storedRoster() };
        await t.fake.addMember('dave.png', { event: false });
        assert.equal(t.tracker.joinTime('dave.png'), START - 9000);
        t.tracker.check('GROUP_UPDATED');
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 9000)]]);
    });

    test('leaves the streaming line out of a cursor read while generating', async () => {
        const t = await setup({ generating: true });
        const lines = [...threeLines(t.fake), t.fake.message({ avatar: 'carol.png', mes: 'Stream', send_date: iso(START) })];
        await t.fake.openChat(lines);
        t.tracker.check('CHAT_CHANGED');
        await t.fake.addMember('dave.png');
        t.tracker.check('GROUP_UPDATED');
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1000)]]);

        t.fake.setGenerating(false);
        await t.fake.openChat(lines, { integrity: 'fake-integrity', [ROSTER_KEY]: structuredClone(t.roster()) });
        t.tracker.check('CHAT_CHANGED');
        await t.fake.addMember('erin.png', { event: false });
        assert.equal(t.tracker.joinTime('erin.png'), START);
    });

    test('raises the cursor at receive and never lowers it', async () => {
        const t = await setup();
        await openThree(t);
        const id = await t.fake.receive('alice.png', 'Back.');
        t.tracker.check('MESSAGE_RECEIVED', { id, type: 'normal' });
        const chat = t.fake.context.chat;
        chat.push(t.fake.message({ avatar: 'bob.png', mes: 'Slow clock.', send_date: iso(START - 5000) }));
        t.tracker.check('MESSAGE_RECEIVED', { id: chat.length - 1, type: 'normal' });
        await t.fake.addMember('dave.png', { event: false });
        assert.equal(t.tracker.joinTime('dave.png'), START + 1000);

        chat.push(t.fake.message({ avatar: 'bob.png', mes: 'Fast clock.', send_date: iso(START + 60000) }));
        t.fake.clock.tick(4000);
        t.tracker.check('MESSAGE_RECEIVED', { id: chat.length - 1, type: 'normal' });
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START + 1000)]]);
        await t.fake.addMember('erin.png', { event: false });
        assert.equal(t.tracker.joinTime('erin.png'), START + 5000);
    });

    test('quiet and dry-run starts do not raise it', async () => {
        const t = await setup();
        await openThree(t);
        t.fake.context.chat.push(t.fake.message({ avatar: 'carol.png', mes: 'Unannounced.', send_date: iso(START) }));
        t.tracker.check('GENERATION_STARTED', { type: 'quiet' });
        t.tracker.check('GENERATION_STARTED', { type: 'normal', dryRun: true });
        await t.fake.addMember('dave.png', { event: false });
        assert.equal(t.tracker.joinTime('dave.png'), START - 1000);

        assert.deepEqual(t.tracker.check('GENERATION_STARTED', { type: 'normal' }),
            { changed: true, save: 'idle', announce: ['dave.png'], warning: null });
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1000)]]);
        await t.fake.addMember('erin.png', { event: false });
        assert.equal(t.tracker.joinTime('erin.png'), START);
    });

    test('applies a join before any trigger records it', async () => {
        const t = await setup();
        await openThree(t);
        const before = t.roster();
        const copy = structuredClone(before);
        await t.fake.addMember('dave.png', { event: false });
        t.fake.settings.update({ scene_history_founders: null });
        const settingsBefore = t.fake.settings.get();

        assert.equal(t.tracker.joinTime('dave.png'), START - 1000);
        assert.equal(t.tracker.joinTime('alice.png'), undefined);
        assert.equal(t.tracker.joinTime('nobody.png'), undefined);
        assert.equal(t.roster(), before);
        assert.deepEqual(t.roster(), copy);
        assert.equal(t.fake.settings.get(), settingsBefore);

        t.fake.settings.update({ scene_join_reveals: [[t.key(), 'dave.png']] });
        assert.equal(t.tracker.joinTime('dave.png'), undefined);
    });

    test('does nothing while characters reload', async () => {
        const t = await setup();
        await openThree(t);
        const before = t.roster();
        await t.fake.addMember('dave.png', { event: false });
        const cards = t.fake.context.characters;
        t.fake.context.characters = [];
        const id = await t.fake.receive('alice.png', 'Back.');
        assert.deepEqual(t.tracker.check('MESSAGE_RECEIVED', { id, type: 'normal' }), nothing());
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'), nothing());
        assert.equal(t.roster(), before);

        t.fake.context.characters = cards;
        t.tracker.check('GROUP_UPDATED');
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1000)]]);
    });

    test('clamps a join when a newer line is dated earlier', async () => {
        const t = await setup();
        await openThree(t);
        await t.fake.addMember('dave.png');
        t.tracker.check('GROUP_UPDATED');
        const chat = t.fake.context.chat;
        chat.push(t.fake.message({ avatar: 'bob.png', mes: 'Slow clock.', send_date: iso(START - 1500) }));
        assert.deepEqual(t.tracker.check('MESSAGE_RECEIVED', { id: chat.length - 1, type: 'normal' }),
            { changed: true, save: 'idle', announce: [], warning: null });
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1501)]]);

        chat.push(t.fake.message({ is_user: true, mes: 'Slower.', send_date: iso(START - 1800) }));
        assert.equal(t.tracker.check('MESSAGE_SENT', { id: chat.length - 1 }).save, 'await');
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1801)]]);
    });

    test('an inserted line never clamps', async () => {
        const t = await setup();
        await openThree(t);
        await t.fake.addMember('dave.png');
        t.tracker.check('GROUP_UPDATED');
        const header = t.roster();
        const chat = t.fake.context.chat;
        chat.splice(1, 0, t.fake.message({ avatar: 'bob.png', mes: 'Inserted.', send_date: iso(START - 2500) }));
        assert.deepEqual(t.tracker.check('MESSAGE_RECEIVED', { id: 1, type: 'command' }), nothing());
        chat.splice(1, 0, t.fake.message({ is_user: true, mes: 'Inserted.', send_date: iso(START - 2600) }));
        assert.deepEqual(t.tracker.check('MESSAGE_SENT', { id: 1 }), nothing());
        assert.equal(t.roster(), header);
    });

    test('a receive of a type outside the clamp list never clamps', async () => {
        const t = await setup();
        await openThree(t);
        await t.fake.addMember('dave.png');
        t.tracker.check('GROUP_UPDATED');
        const header = t.roster();
        const chat = t.fake.context.chat;
        chat.push(t.fake.message({ avatar: 'bob.png', mes: 'From an extension.', send_date: iso(START - 1500) }));
        assert.deepEqual(t.tracker.check('MESSAGE_RECEIVED', { id: chat.length - 1, type: 'extension' }), nothing());
        assert.equal(t.roster(), header);
    });

    test('reports the save each trigger needs', async () => {
        const t = await setup();
        await openThree(t);
        const chat = t.fake.context.chat;
        const add = avatar => t.fake.addMember(avatar, { event: false });

        await add('dave.png');
        assert.equal(t.tracker.check('GENERATION_STARTED', { type: 'normal' }).save, 'idle');
        await add('erin.png');
        let id = await t.fake.receive('alice.png', 'Typed.', 'command', { emitEvent: false });
        assert.deepEqual(t.tracker.check('MESSAGE_RECEIVED', { id, type: 'command' }),
            { changed: true, save: null, announce: ['erin.png'], warning: null });
        await add('frank.png');
        chat.splice(1, 0, t.fake.message({ avatar: 'bob.png', mes: 'Inserted.' }));
        assert.equal(t.tracker.check('MESSAGE_RECEIVED', { id: 1, type: 'command' }).save, 'await');
        await add('gina.png');
        id = await t.fake.receive('carol.png', 'Reply.', 'normal', { emitEvent: false });
        assert.equal(t.tracker.check('MESSAGE_RECEIVED', { id, type: 'normal' }).save, 'idle');
        await add('hank.png');
        assert.deepEqual(t.tracker.check('init'), { changed: true, save: null, announce: ['hank.png'], warning: null });
        await add('ivy.png');
        assert.equal(t.tracker.check('turn-on').save, null);
        assert.deepEqual(t.roster().joined.map(([avatar]) => avatar),
            ['dave.png', 'erin.png', 'frank.png', 'gina.png', 'hank.png', 'ivy.png']);
    });

    test('caps a join found at open below the member\'s first own line, for that check only', async () => {
        const t = await setup({ members: [...FOUNDERS, 'dave.png'] });
        const lines = threeLines(t.fake);
        lines.splice(1, 0,
            t.fake.message({ avatar: 'dave.png', mes: 'Written as Dave.', send_date: iso(START - 2500) }),
            t.fake.message({ avatar: 'erin.png', mes: 'Written as Erin.', send_date: iso(START - 1500) }));
        await t.fake.openChat(lines, { integrity: 'fake-integrity', [ROSTER_KEY]: storedRoster() });
        assert.deepEqual(t.tracker.check('CHAT_CHANGED').announce, ['dave.png']);
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 2501)]]);

        await t.fake.addMember('erin.png');
        t.tracker.check('GROUP_UPDATED');
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 2501)], ['erin.png', iso(START - 1000)]]);
    });

    test('forgetJoin removes the join and keeps a reveal pair until a save carries it', async () => {
        const join = iso(START - 2000);
        const stored = storedRoster({ known: [...FOUNDERS, 'dave.png'], joined: [['dave.png', join]] });
        const t = await setup({ members: [...FOUNDERS, 'dave.png'] });
        await openThree(t, { integrity: 'fake-integrity', [ROSTER_KEY]: structuredClone(stored) });
        const key = t.key();
        assert.equal(t.tracker.joinTime('dave.png'), START - 2000);

        const header = t.roster();
        assert.deepEqual(t.tracker.forgetJoin('dave.png', key), { ok: true, applied: true });
        assert.notEqual(t.roster(), header);
        assert.deepEqual(header.joined, [['dave.png', join]]);
        assert.deepEqual(t.roster().joined, []);
        assert.deepEqual(t.roster().known, [...FOUNDERS, 'dave.png']);
        assert.deepEqual(t.reveals(), [[key, 'dave.png']]);
        assert.equal(t.tracker.joinTime('dave.png'), undefined);

        t.fake.context.saveResult = false;
        assert.equal(await t.saver.save(), false);
        assert.deepEqual(t.reveals(), [[key, 'dave.png']]);

        // A reload reads the file, which still holds the join; the pending pair takes it out again.
        await openThree(t, { integrity: 'fake-integrity', [ROSTER_KEY]: structuredClone(stored) });
        assert.deepEqual(t.roster().joined, []);
        assert.deepEqual(t.reveals(), [[key, 'dave.png']]);
        assert.equal(t.tracker.joinTime('dave.png'), undefined);

        t.fake.context.saveResult = true;
        assert.equal(await t.saver.save(), true);
        assert.equal(t.reveals(), null);
    });

    test('forgetJoin for a chat that is not open only stores the pair', async () => {
        const t = await setup();
        await openThree(t);
        const header = t.roster();
        const other = JSON.stringify(['g1', 'c9']);
        assert.deepEqual(t.tracker.forgetJoin('dave.png', other), { ok: true, applied: false });
        assert.equal(t.roster(), header);
        assert.deepEqual(t.reveals(), [[other, 'dave.png']]);
        assert.equal(await t.saver.save(), true);
        assert.deepEqual(t.reveals(), [[other, 'dave.png']]);
        assert.deepEqual(t.tracker.forgetJoin('', other), { ok: false, applied: false });
        assert.deepEqual(t.tracker.forgetJoin('dave.png', ''), { ok: false, applied: false });
    });

    test('a save that resolves after the chat changed drops no pair', async () => {
        const first = JSON.stringify(['g1', 'c1']);
        const second = JSON.stringify(['g1', 'c2']);
        const t = await setup({ settings: { scene_join_reveals: [[first, 'dave.png']] } });
        await openThree(t);
        let finish;
        t.fake.context.saveChat = () => new Promise(resolve => { finish = resolve; });
        const saving = t.saver.save();

        switchChat(t.fake, 'c2');
        await openThree(t, { integrity: 'fake-integrity',
            [ROSTER_KEY]: storedRoster({ known: [...FOUNDERS, 'dave.png'], joined: [['dave.png', iso(START - 2000)]] }) });
        assert.deepEqual(t.tracker.forgetJoin('dave.png', second), { ok: true, applied: true });
        finish(true);
        assert.equal(await saving, true);
        assert.deepEqual(t.reveals(), [[first, 'dave.png'], [second, 'dave.png']]);
    });

    test('a save keeps the pair of a join forgotten while it was in flight', async () => {
        const stored = storedRoster({ known: [...FOUNDERS, 'dave.png', 'erin.png'],
            joined: [['dave.png', iso(START - 2000)], ['erin.png', iso(START - 2000)]] });
        const t = await setup({ members: [...FOUNDERS, 'dave.png', 'erin.png'],
            cards: [...FOUNDERS, 'dave.png', 'erin.png'] });
        await openThree(t, { integrity: 'fake-integrity', [ROSTER_KEY]: stored });
        const key = t.key();
        t.tracker.forgetJoin('dave.png', key);
        let finish;
        t.fake.context.saveChat = () => new Promise(resolve => { finish = resolve; });
        const saving = t.saver.save();

        t.tracker.forgetJoin('erin.png', key);
        finish(true);
        assert.equal(await saving, true);
        assert.deepEqual(t.reveals(), [[key, 'erin.png']]);
    });

    test('drops a reveal pair once the opened file carries the removal', async () => {
        const kept = [JSON.stringify(['g1', 'c2']), 'dave.png'];
        const t = await setup({ members: [...FOUNDERS, 'dave.png'],
            settings: { scene_join_reveals: [[JSON.stringify(['g1', 'c1']), 'dave.png'], kept] } });
        await openThree(t, { integrity: 'fake-integrity',
            [ROSTER_KEY]: storedRoster({ known: [...FOUNDERS, 'dave.png'] }) });
        assert.deepEqual(t.reveals(), [kept]);

        switchChat(t.fake, 'c2');
        await openThree(t, { integrity: 'fake-integrity',
            [ROSTER_KEY]: storedRoster({ known: [...FOUNDERS, 'dave.png'] }) });
        assert.equal(t.reveals(), null);
    });

    test('stops listening for saves once destroyed', async () => {
        const stored = storedRoster({ known: [...FOUNDERS, 'dave.png'], joined: [['dave.png', iso(START - 2000)]] });
        const t = await setup({ members: [...FOUNDERS, 'dave.png'] });
        await openThree(t, { integrity: 'fake-integrity', [ROSTER_KEY]: stored });
        t.tracker.forgetJoin('dave.png', t.key());
        t.tracker.destroy();
        assert.equal(await t.saver.save(), true);
        assert.deepEqual(t.reveals(), [[t.key(), 'dave.png']]);
    });

    test('keeps the founders snapshot current with the token', async () => {
        const t = await setup({ settings: { scene_history_founders: null } });
        await openThree(t);
        const founders = () => t.fake.settings.get().scene_history_founders;
        assert.deepEqual(founders(), { since: TOKEN, groups: { g1: FOUNDERS } });
        const current = founders();
        t.tracker.check('GROUP_UPDATED');
        assert.equal(founders(), current);

        t.fake.settings.update({ scene_history_founders: { since: '2026-10-07T00:00:00.000Z',
            groups: { g0: ['x.png'], g1: ['erin.png'] } } });
        t.tracker.check('GROUP_UPDATED');
        assert.deepEqual(founders(), { since: TOKEN, groups: { g1: FOUNDERS } });

        t.fake.settings.update({ scene_history_founders: { since: TOKEN, groups: { g0: ['x.png'] } } });
        t.tracker.check('GROUP_UPDATED');
        assert.deepEqual(founders(), { since: TOKEN, groups: { g0: ['x.png'], g1: FOUNDERS } });
    });

    test('uses the founders snapshot only in chats that existed at turn-on', async () => {
        const t = await setup({ cards: [...FOUNDERS, 'erin.png'],
            settings: { scene_history_founders: { since: TOKEN, groups: { g1: [...FOUNDERS, 'erin.png'] } } } });
        const older = [t.fake.message({ avatar: 'alice.png', mes: 'Before.', send_date: iso(BEFORE_TOKEN) }),
            ...threeLines(t.fake)];
        await t.fake.openChat(older);
        t.tracker.check('CHAT_CHANGED');
        assert.deepEqual(t.roster().known, [...FOUNDERS, 'erin.png']);
        const olderHeader = t.fake.context.chatMetadata;

        switchChat(t.fake, 'c2');
        await openThree(t);
        assert.deepEqual(t.roster().known, FOUNDERS);
        await t.fake.addMember('erin.png');
        t.tracker.check('GROUP_UPDATED');
        assert.deepEqual(t.roster().joined, [['erin.png', iso(START - 1000)]]);

        switchChat(t.fake, 'c1');
        await t.fake.openChat(older, olderHeader);
        assert.deepEqual(t.tracker.check('CHAT_CHANGED'), nothing());
        assert.deepEqual(t.roster().joined, []);
    });

    test('warns once per chat for invalid and foreign rosters', async () => {
        const t = await setup();
        const invalid = { v: 1, group: '', since: TOKEN, known: [], joined: [] };
        const header = roster => ({ integrity: 'fake-integrity', [ROSTER_KEY]: roster });
        assert.deepEqual(await openThree(t, header(structuredClone(invalid))),
            { changed: true, save: null, announce: [], warning: 'invalid' });
        assert.deepEqual(t.roster().known, FOUNDERS);
        const again = await openThree(t, header(structuredClone(invalid)));
        assert.equal(again.changed, true);
        assert.equal(again.warning, null);

        switchChat(t.fake, 'c2');
        const foreign = { v: 2, group: 'g1', future: true };
        assert.deepEqual(await openThree(t, header(foreign)),
            { changed: false, save: null, announce: [], warning: 'foreign' });
        assert.equal(t.roster(), foreign);
        assert.deepEqual(foreign, { v: 2, group: 'g1', future: true });
        await t.fake.addMember('dave.png', { event: false });
        assert.equal(t.tracker.joinTime('dave.png'), undefined);
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'), nothing());
        assert.equal(t.roster(), foreign);

        switchChat(t.fake, 'c3');
        assert.equal((await openThree(t, header(structuredClone(invalid)))).warning, 'invalid');
    });

    test('renames the roster in a past chat without an open group', async () => {
        const t = await setup();
        t.fake.context.groupId = null;
        assert.equal(t.tracker.gate(), false);
        const join = iso(START - 1000);
        const stored = storedRoster({ known: [...FOUNDERS, 'dave.png'], joined: [['dave.png', join]] });
        const copy = structuredClone(stored);
        const header = { chat_metadata: { integrity: 'fake-integrity', [ROSTER_KEY]: stored } };
        t.tracker.rename([header, { original_avatar: 'dan.png', mes: 'Hi.' }], 'dave.png', 'dan.png');
        assert.deepEqual(header.chat_metadata[ROSTER_KEY],
            { ...copy, known: [...FOUNDERS, 'dan.png'], joined: [['dan.png', join]] });
        assert.deepEqual(stored, copy);

        const foreign = { v: 2 };
        const foreignHeader = { chat_metadata: { [ROSTER_KEY]: foreign } };
        t.tracker.rename([foreignHeader], 'alice.png', 'ally.png');
        assert.equal(foreignHeader.chat_metadata[ROSTER_KEY], foreign);
        const bare = { chat_metadata: {} };
        t.tracker.rename([bare], 'alice.png', 'ally.png');
        assert.deepEqual(bare, { chat_metadata: {} });
        const untouched = { chat_metadata: { [ROSTER_KEY]: copy } };
        t.tracker.rename([untouched], 'zed.png', 'zack.png');
        assert.equal(untouched.chat_metadata[ROSTER_KEY], copy);
        t.tracker.rename(undefined, 'alice.png', 'ally.png');

        t.fake.settings.update({ scene_history: false });
        t.tracker.rename([untouched], 'alice.png', 'ally.png');
        assert.equal(untouched.chat_metadata[ROSTER_KEY], copy);
    });

    test('does nothing when scene memory is off, the token is null or the store is unsupported', async () => {
        const join = iso(START - 2000);
        const variants = [
            ['scene memory off', { scene_history: false }],
            ['scene controls off', { scene_controls: false }],
            ['no token', { scene_history_since: null }],
            ['unreadable token', { scene_history_since: 'whenever' }],
            ['unsupported store', { current_scenes: { version: 2, chats: {} } }],
        ];
        for (const [label, settings] of variants) {
            const t = await setup({ members: [...FOUNDERS, 'dave.png'], settings });
            const stored = storedRoster({ known: [...FOUNDERS, 'dave.png'], joined: [['dave.png', join]] });
            assert.deepEqual(await openThree(t, { integrity: 'fake-integrity', [ROSTER_KEY]: stored }), nothing(), label);
            assert.equal(t.tracker.gate(), false, label);
            assert.equal(t.roster(), stored, label);
            assert.equal(t.saver.isLoaded(), true, label);
            await t.fake.addMember('erin.png');
            assert.deepEqual(t.tracker.check('GROUP_UPDATED'), nothing(), label);
            assert.equal(t.tracker.joinTime('dave.png'), undefined, label);
            assert.equal(t.tracker.joinTime('erin.png'), undefined, label);
            assert.deepEqual(t.tracker.forgetJoin('dave.png', t.key()), { ok: true, applied: false }, label);
            assert.equal(t.roster(), stored, label);
            assert.equal(t.fake.settings.get().scene_history_founders, undefined, label);
        }

        const t = await setup();
        await openThree(t);
        t.fake.context.groupId = null;
        assert.equal(t.tracker.gate(), false);
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'), nothing());
        assert.equal(t.tracker.joinTime('alice.png'), undefined);
    });

    test('a member without a card stops the check', async () => {
        const stored = storedRoster({ known: [...FOUNDERS, 'dave.png'], joined: [['dave.png', iso(START - 2000)]] });
        const t = await setup({ members: [...FOUNDERS, 'dave.png', 'ghost.png'] });
        assert.deepEqual(await openThree(t, { integrity: 'fake-integrity', [ROSTER_KEY]: stored }), nothing());
        assert.equal(t.tracker.gate(), true);
        assert.equal(t.roster(), stored);
        assert.equal(t.tracker.joinTime('dave.png'), START - 2000);
        assert.equal(t.tracker.joinTime('ghost.png'), undefined);
        t.fake.settings.update({ scene_join_reveals: [[t.key(), 'dave.png']] });
        assert.equal(t.tracker.joinTime('dave.png'), undefined);
    });

    test('a stopped check ignores a stored roster of another group', async () => {
        const stored = storedRoster({ group: 'g2', known: [...FOUNDERS, 'dave.png'],
            joined: [['dave.png', iso(START - 2000)]] });
        const t = await setup({ members: [...FOUNDERS, 'dave.png', 'ghost.png'] });
        assert.deepEqual(await openThree(t, { integrity: 'fake-integrity', [ROSTER_KEY]: stored }), nothing());
        assert.equal(t.roster(), stored);
        assert.equal(t.tracker.joinTime('dave.png'), undefined);
    });

    test('logs a failed check once and falls back to the stored join', async () => {
        const stored = storedRoster({ known: [...FOUNDERS, 'dave.png'], joined: [['dave.png', iso(START - 2000)]] });
        const t = await setup({ members: [...FOUNDERS, 'dave.png'] });
        await openThree(t, { integrity: 'fake-integrity', [ROSTER_KEY]: stored });
        const header = t.roster();
        t.fake.host.memberIds = () => { throw new Error('host failed'); };
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'), nothing());
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'), nothing());
        assert.equal(t.logs.length, 1);
        assert.equal(t.roster(), header);
        assert.equal(t.tracker.joinTime('dave.png'), START - 2000);
    });

    test('logs a check that fails before it reconciles once', async () => {
        const t = await setup();
        await openThree(t);
        t.fake.host.resolveMembers = () => { throw new Error('host failed'); };
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'), nothing());
        assert.deepEqual(t.tracker.check('CHAT_CHANGED'), nothing());
        assert.equal(t.logs.length, 1);
    });

    test('a failed settings write leaves the header alone', async () => {
        const t = await setup();
        await openThree(t);
        const header = t.roster();
        await t.fake.addMember('dave.png', { event: false });
        t.fake.settings.update({ scene_history_founders: null });
        const update = t.fake.settings.update;
        t.fake.settings.update = () => { throw new Error('settings failed'); };
        assert.deepEqual(t.tracker.check('MESSAGE_SENT', { id: await t.fake.sendUser('hi', { emitEvent: false }) }),
            nothing());
        assert.equal(t.roster(), header);
        assert.equal(t.logs.length, 1);

        t.fake.settings.update = update;
        assert.deepEqual(t.tracker.check('GROUP_UPDATED'),
            { changed: true, save: 'idle', announce: ['dave.png'], warning: null });
        assert.deepEqual(t.roster().joined, [['dave.png', iso(START - 1000)]]);
    });

    test('reset forgets the cursor', async () => {
        const t = await setup();
        await openThree(t);
        const id = await t.fake.receive('alice.png', 'Back.');
        t.tracker.check('MESSAGE_RECEIVED', { id, type: 'normal' });
        t.fake.clock.tick(2000);
        t.fake.context.chat.push(t.fake.message({ avatar: 'bob.png', mes: 'Unannounced.', send_date: iso(START + 2000) }));
        await t.fake.addMember('dave.png', { event: false });
        assert.equal(t.tracker.joinTime('dave.png'), START + 1000);
        t.tracker.reset();
        assert.equal(t.tracker.joinTime('dave.png'), START + 2000);
    });

    test('treats odd avatars as exact keys', async () => {
        const t = await setup({ cards: [...FOUNDERS, '__proto__', 'constructor'] });
        await openThree(t);
        await t.fake.addMember('__proto__');
        assert.deepEqual(t.tracker.check('GROUP_UPDATED').announce, ['__proto__']);
        assert.deepEqual(t.roster().joined, [['__proto__', iso(START - 1000)]]);
        assert.equal(t.tracker.joinTime('__proto__'), START - 1000);
        assert.equal(t.tracker.joinTime('constructor'), undefined);
        assert.deepEqual(t.tracker.forgetJoin('__proto__', t.key()), { ok: true, applied: true });
        assert.deepEqual(t.roster().joined, []);
        assert.deepEqual(t.reveals(), [[t.key(), '__proto__']]);
    });
});
