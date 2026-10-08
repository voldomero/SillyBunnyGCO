import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHostAdapter } from '../src/host-adapter.js';
import { createSceneRecorder } from '../src/scene-recorder.js';
import { ROSTER_KEY } from '../src/scene-roster.js';
import { createSceneStore } from '../src/scene-state.js';
import { SCENE_TEXT } from '../src/scene-text.js';
import { createFakeHost } from './helpers/fake-host.mjs';

const START = Date.UTC(2026, 9, 8, 1, 0, 0);
const TOKEN = '2026-10-08T00:00:00.000Z';
const NEW_TOKEN = '2026-10-08T02:00:00.000Z';
const FOUNDERS = ['alice.png', 'bob.png', 'carol.png'];
const WITH_DAVE = [...FOUNDERS, 'dave.png'];
const iso = ms => new Date(ms).toISOString();
const away = (...avatars) => ({ sbu_scene: { v: 1, away: avatars } });
const noted = (...avatars) => ({ v: 1, away: avatars });
const note = line => line?.extra?.sbu_scene;
const entryNote = (line, index) => line?.swipe_info?.[index]?.extra?.sbu_scene;
const promptOf = chat => chat.map(message => ({ ...message }));
const header = joined => ({ integrity: 'fake-integrity', [ROSTER_KEY]: { v: 1, group: 'g1', since: TOKEN, floor: null,
    known: [...FOUNDERS, ...joined.map(([avatar]) => avatar)], gone: [], joined } });

/** A recorder over an existing fake host, as GCO starts after the chat may already be open. */
function attach(fake, options = {}) {
    const logs = [];
    const scene = createSceneStore(fake);
    const recorder = createSceneRecorder({ host: fake.host, settings: fake.settings, scene,
        now: fake.clock.now, log: (...args) => logs.push(args), ...options });
    return { fake, recorder, logs, scene };
}

async function setup(options = {}) {
    return attach(await createFakeHost(options));
}

/** Alice, the user and Bob, one second apart; Bob's line is a second before the fake clock starts. */
function lines3(fake) {
    return [
        fake.message({ avatar: 'alice.png', mes: 'Hello.', send_date: iso(START - 3000) }),
        fake.message({ is_user: true, mes: 'Hi.', send_date: iso(START - 2000) }),
        fake.message({ avatar: 'bob.png', mes: 'Hey.', send_date: iso(START - 1000) }),
    ];
}

/** A chat used with scene controls before has a scene entry, so opening it seeds nothing (§3). */
function keepScene(t) {
    const stored = t.fake.settings.get().current_scenes ?? { version: 1, chats: {} };
    const key = t.fake.host.activeConversation().key;
    if (stored.version !== 1 || Object.hasOwn(stored.chats, key)) return;
    t.fake.settings.update({ current_scenes: { ...stored, chats: { ...stored.chats, [key]: { members: {} } } } });
}

/** Open a chat used before and mark members away in its scene (Bob unless stated). */
async function openScene(t, lines, { absent = ['bob.png'], metadata } = {}) {
    keepScene(t);
    await t.fake.openChat(lines, metadata);
    for (const avatar of absent) assert.equal(t.scene.setState(avatar, 'absent').ok, true, avatar);
}

/** Extra versions of a line, as a loaded chat holds them. */
function withVersions(line, ...texts) {
    for (const text of texts) {
        line.swipes.push(text);
        line.swipe_info.push({ send_date: line.send_date, extra: {} });
    }
    return line;
}

/** Push a line and announce it with `event`, as the host's appending paths do. */
async function push(fake, line, event, ...args) {
    const id = fake.context.chat.push(line) - 1;
    await fake.emit(event, id, ...args);
    return id;
}

const wrapper = (fake, name, type) => fake.emit(name, { selected_group: 'g1', type });
const started = (fake, type = 'normal') => wrapper(fake, 'GROUP_WRAPPER_STARTED', type);
const finished = (fake, type = 'normal') => wrapper(fake, 'GROUP_WRAPPER_FINISHED', type);

const statusOf = (t, avatar) => t.scene.getSnapshot().participants.find(member => member.avatar === avatar)?.status;
const statusesOf = t => Object.fromEntries(t.scene.getSnapshot().participants.map(member => [member.avatar, member.status]));
const keyOf = t => t.fake.host.activeConversation().key;
/** A toast as shownToasts() lists it when it offers Undo. */
const withUndo = toast => ({ ...toast, actionLabel: SCENE_TEXT.P12, onAction: 'function' });
const applied = withUndo({ level: 'info', text: SCENE_TEXT.P11 });

function switchChat(fake, chatId) {
    fake.context.chatId = chatId;
    fake.group.chat_id = chatId;
}

/** Saves that finish a few milliseconds later, each keeping a copy of the chat and header it was given. */
function slowSaves(fake) {
    const done = [];
    fake.context.saveChat = async options => {
        const chat = structuredClone(fake.context.chat);
        const metadata = structuredClone(fake.context.chatMetadata);
        await new Promise(resolve => setTimeout(resolve, 5));
        done.push({ options, chat, metadata });
        return true;
    };
    return done;
}

/** A prompt item whose `extra` getter throws `thrown`, as a broken extension property might. */
function unreadable(thrown) {
    const item = { mes: 'broken', send_date: iso(START) };
    Object.defineProperty(item, 'extra', { get() { throw thrown; } });
    return item;
}

/** A line everyone saw, then a line Bob missed. */
async function openMissed(fake) {
    await fake.openChat([
        fake.message({ avatar: 'alice.png', mes: 'one', send_date: iso(START - 2000) }),
        fake.message({ avatar: 'alice.png', mes: 'two', send_date: iso(START - 1000), extra: away('bob.png') }),
    ]);
}

describe('scene text', () => {
    test('defines every string once, frozen', () => {
        const keys = ['P1', 'P1h', 'P2', 'P2h', ...Array.from({ length: 26 }, (_, index) => `P${index + 3}`),
            'P4off', 'P6present', 'P6absent', 'P6remote', 'P6unspecified', 'P10line', 'P21none', 'R1'];
        assert.ok(Object.isFrozen(SCENE_TEXT));
        assert.deepEqual(Object.keys(SCENE_TEXT).sort(), [...keys].sort());
    });
});

describe('scene recorder prompt filter', () => {
    test('blanks lines the speaker missed and nothing else', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        const live = fake.context.chat;
        const ignore = fake.context.symbols.ignore;
        const items = promptOf(live);
        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 1);
        assert.equal(items.length, 2);
        assert.equal(items[0].mes, 'one');
        assert.equal(items[1].mes, '');
        assert.equal(items[1].name, '');
        assert.equal(items[1].is_user, false);
        assert.equal(items[1].extra[ignore], true);
        assert.equal(live[1].mes, 'two');
        assert.equal(live[1].extra[ignore], undefined);
        assert.equal(recorder.filter(items, 'normal', 'alice.png'), 0);
        const forCarol = promptOf(live);
        assert.equal(recorder.filter(forCarol, 'normal', 'carol.png'), 0);
        assert.deepEqual(forCarol, promptOf(live));
    });

    test('leaves quiet and impersonate prompts untouched', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        for (const type of ['quiet', 'impersonate', undefined]) {
            const items = promptOf(fake.context.chat);
            assert.equal(recorder.filter(items, type, 'bob.png'), 0, String(type));
            assert.deepEqual(items, promptOf(fake.context.chat), String(type));
        }
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'bob.png'), 1);
    });

    test('filters swipes and keeps the continue target', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        const swiped = promptOf(fake.context.chat);
        assert.equal(recorder.filter(swiped, 'swipe', 'bob.png'), 1);
        assert.equal(swiped[1].mes, '');
        const continued = promptOf(fake.context.chat);
        assert.equal(recorder.filter(continued, 'continue', 'bob.png'), 0);
        assert.equal(continued[1].mes, 'two');
        fake.context.chat.push(fake.message({ avatar: 'carol.png', mes: 'three' }));
        const longer = promptOf(fake.context.chat);
        assert.equal(recorder.filter(longer, 'continue', 'bob.png'), 1);
        assert.deepEqual(longer.map(item => item.mes), ['one', '', 'three']);
    });

    test('steps aside for Vocalia', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        fake.context.extensionSettings.aspect_vocalia = { enabled: true };
        const items = promptOf(fake.context.chat);
        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 0);
        assert.equal(items[1].mes, 'two');
        assert.equal(recorder.status().steppedAside, true);
        assert.equal(recorder.hiddenFor('bob.png').skipped, 'vocalia');

        fake.context.extensionSettings.aspect_vocalia.occludeUnwitnessedHistory = false;
        assert.equal(recorder.status().steppedAside, false);
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'bob.png'), 1);
    });

    test('skips omniscient speakers', async () => {
        const { fake, recorder } = await setup();
        await fake.openChat([fake.message({ avatar: 'alice.png', mes: 'one', extra: away('bob.png', 'carol.png') })]);
        let writes = 0;
        fake.settings.subscribe(() => writes++);

        recorder.setOmniscient('bob.png', true);
        assert.equal(recorder.isOmniscient('bob.png'), true);
        assert.deepEqual(fake.settings.get().scene_omniscient, { 'bob.png': true });
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'bob.png'), 0);
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'carol.png'), 1);
        assert.deepEqual(recorder.hiddenFor('bob.png'), { away: 0, joined: 0, lines: [], skipped: 'omniscient' });

        recorder.setOmniscient('bob.png', false);
        assert.equal(recorder.isOmniscient('bob.png'), false);
        assert.equal(fake.settings.get().scene_omniscient, null);
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'bob.png'), 1);

        recorder.setOmniscient('__proto__', true);
        const flags = fake.settings.get().scene_omniscient;
        assert.equal(Object.hasOwn(flags, '__proto__'), true);
        assert.equal(Object.getPrototypeOf(flags), Object.prototype);
        assert.equal(recorder.isOmniscient('__proto__'), true);
        assert.equal(recorder.isOmniscient('constructor'), false);
        assert.equal(writes, 3);
        recorder.setOmniscient('__proto__', true);
        recorder.setOmniscient('carol.png', false);
        assert.equal(writes, 3);
    });

    test('never writes knows-everything for an invalid avatar', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        let writes = 0;
        fake.settings.subscribe(() => writes++);
        for (const avatar of [undefined, null, '', 42]) {
            recorder.setOmniscient(avatar, true);
            assert.equal(recorder.isOmniscient(avatar), false, String(avatar));
        }
        assert.equal(writes, 0);
        assert.equal(Object.hasOwn(fake.settings.get(), 'scene_omniscient'), false);
    });

    test('does nothing when scene controls or scene memory are off or the host has no ignore symbol', async () => {
        for (const patch of [{ scene_controls: false }, { scene_history: false }]) {
            const { fake, recorder } = await setup({ settings: patch });
            await openMissed(fake);
            const items = promptOf(fake.context.chat);
            assert.equal(recorder.filter(items, 'normal', 'bob.png'), 0, JSON.stringify(patch));
            assert.equal(items[1].mes, 'two');
            assert.equal(recorder.status().history, false);
            assert.equal(recorder.hiddenFor('bob.png').skipped, 'off');
        }

        const { fake, recorder } = await setup();
        await openMissed(fake);
        delete fake.context.symbols;
        const items = promptOf(fake.context.chat);
        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 0);
        assert.equal(items[1].mes, 'two');
        assert.deepEqual(recorder.status().capable, { history: false, automatic: false });
        assert.equal(recorder.status().history, false);
        assert.equal(recorder.hiddenFor('bob.png').skipped, 'unavailable');
    });

    test('does nothing without an open group', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        fake.context.groupId = null;
        const items = promptOf(fake.context.chat);
        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 0);
        assert.equal(items[1].mes, 'two');
        assert.equal(recorder.hiddenFor('bob.png').skipped, 'off');
    });

    test('leaves the prompt untouched for an unresolved speaker', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        // Two cards with one avatar: the host resolves neither, so groupUtils has no speaker to pass.
        fake.context.characters.push({ name: 'Other Bob', avatar: 'bob.png' });
        const speaker = fake.host.resolveMembers().find(member => member.avatar === 'bob.png')?.avatar;
        assert.equal(speaker, undefined);
        for (const unresolved of [speaker, null, '', 42]) {
            const items = promptOf(fake.context.chat);
            assert.equal(recorder.filter(items, 'normal', unresolved), 0, String(unresolved));
            assert.deepEqual(items, promptOf(fake.context.chat));
        }
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'bob.png'), 1);
    });

    test('leaves the prompt untouched when planning throws', async () => {
        const { fake, recorder, logs } = await setup();
        await fake.openChat([
            fake.message({ avatar: 'alice.png', mes: 'secret', extra: away('bob.png') }),
            fake.message({ avatar: 'carol.png', mes: 'also secret', extra: away('bob.png') }),
        ]);
        let notified = 0;
        recorder.subscribe(() => notified++);
        const broken = unreadable(new Error('unreadable extra'));
        const items = promptOf(fake.context.chat);
        items.splice(1, 0, broken);
        const before = [...items];
        const copy = items.map(item => item === broken ? item : structuredClone(item));

        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 0);
        assert.equal(items.length, 3);
        items.forEach((item, index) => assert.equal(item, before[index]));
        assert.deepEqual(items, copy);
        assert.match(recorder.status().lastError, /unreadable extra/);
        assert.equal(logs.length, 1);
        assert.equal(notified, 1);

        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 0);
        assert.equal(logs.length, 1);
        assert.equal(notified, 1);
    });

    test('never throws, even for a thrown value that cannot become a string', async () => {
        const { fake, recorder, logs } = await setup();
        await openMissed(fake);
        const broken = unreadable(Object.create(null));
        const items = [...promptOf(fake.context.chat), broken];
        const before = [...items];

        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 0);
        items.forEach((item, index) => assert.equal(item, before[index]));
        assert.equal(typeof recorder.status().lastError, 'string');
        assert.equal(logs.length, 1);

        fake.context.chat.push(broken);
        assert.equal(recorder.hiddenFor('bob.png').skipped, 'unavailable');
    });

    test('clears the error once a later filter plans without throwing', async () => {
        const { fake, recorder, logs } = await setup();
        await openMissed(fake);
        let notified = 0;
        recorder.subscribe(() => notified++);
        const broken = unreadable(new Error('unreadable extra'));

        assert.equal(recorder.filter([...promptOf(fake.context.chat), broken], 'normal', 'bob.png'), 0);
        assert.match(recorder.status().lastError, /unreadable extra/);
        assert.equal(notified, 1);
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'quiet', 'bob.png'), 0);
        assert.match(recorder.status().lastError, /unreadable extra/);

        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'bob.png'), 1);
        assert.equal(recorder.status().lastError, null);
        assert.equal(notified, 2);
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'alice.png'), 0);
        assert.equal(notified, 2);

        assert.equal(recorder.filter([broken], 'normal', 'bob.png'), 0);
        assert.match(recorder.status().lastError, /unreadable extra/);
        assert.equal(notified, 3);
        assert.equal(logs.length, 1);
    });

    test('hides pre-join lines from a member added without an event', async () => {
        const { fake, recorder } = await setup();
        await fake.openChat([
            fake.message({ avatar: 'alice.png', mes: 'Hello.', send_date: iso(START - 3000) }),
            fake.message({ is_user: true, mes: 'Hi.', send_date: iso(START - 2000) }),
            fake.message({ avatar: 'bob.png', mes: 'Hey.', send_date: iso(START - 1000) }),
        ], header([]));
        const stored = structuredClone(fake.context.chatMetadata);
        await fake.addMember('dave.png', { event: false });

        const items = promptOf(fake.context.chat);
        assert.equal(recorder.filter(items, 'normal', 'dave.png'), 3);
        assert.deepEqual(items.map(item => item.mes), ['', '', '']);
        assert.equal(recorder.filter(promptOf(fake.context.chat), 'normal', 'alice.png'), 0);
        assert.deepEqual(fake.context.chatMetadata, stored);
        assert.deepEqual(fake.saves, []);
    });

    test('keeps the away rule when only the join rule is off', async () => {
        const lines = fake => [
            fake.message({ avatar: 'alice.png', mes: 'Before Dave.', send_date: iso(START - 9000) }),
            fake.message({ avatar: 'bob.png', mes: 'Dave missed this.', send_date: iso(START - 1000), extra: away('dave.png') }),
        ];
        const cases = [
            [{}, 2],
            [{ scene_history_since: null }, 1],
            [{ current_scenes: { version: 2 } }, 1],
        ];
        for (const [settings, expected] of cases) {
            const { fake, recorder } = await setup({ members: WITH_DAVE, settings });
            await fake.openChat(lines(fake), header([['dave.png', iso(START - 5000)]]));
            const items = promptOf(fake.context.chat);
            assert.equal(recorder.filter(items, 'normal', 'dave.png'), expected, JSON.stringify(settings));
            assert.deepEqual(items.map(item => item.mes), [expected === 2 ? '' : 'Before Dave.', '']);
        }
    });

    test('tolerates unusual prompt items', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        const items = [
            { mes: 42, send_date: 7 },
            { mes: 'no extra' },
            { mes: 'null extra', extra: null },
            { mes: 'garbage note', extra: { sbu_scene: 'bob.png' } },
            { mes: 'missed', extra: away('bob.png'), swipe_id: 9, swipe_info: [] },
        ];
        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 1);
        assert.deepEqual(items.map(item => item.mes), [42, 'no extra', 'null extra', 'garbage note', '']);
    });

    test('stops filtering after destroy', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        let notified = 0;
        recorder.subscribe(() => notified++);
        recorder.destroy();
        recorder.destroy();
        const items = promptOf(fake.context.chat);
        assert.equal(recorder.filter(items, 'normal', 'bob.png'), 0);
        assert.equal(items[1].mes, 'two');
        assert.equal(recorder.hiddenFor('bob.png').skipped, 'off');
        assert.equal(notified, 0);
    });
});

describe('scene recorder preview and status', () => {
    test('counts hidden lines for the preview by rule', async () => {
        const { fake, recorder } = await setup({ members: WITH_DAVE });
        const at = (offset, fields) => fake.message({ send_date: iso(START - offset), ...fields });
        await fake.openChat([
            at(9000, { avatar: 'alice.png', mes: 'The hall is quiet.' }),
            at(8000, { is_user: true, mes: 42 }),
            at(7000, { avatar: 'bob.png', mes: 'Psst.', extra: away('dave.png') }),
            at(6000, { avatar: 'carol.png',
                mes: '  Carol   waves\n\nat everyone, then mentions the thunderstorm rolling over the hills.' }),
            at(5500, { avatar: 'bob.png', mes: 'Hidden aside.', is_system: true, extra: away('dave.png') }),
            at(5000, { avatar: 'alice.png', mes: `${'x'.repeat(59)}😀 and more` }),
            at(4000, { is_user: true, mes: 'Whisper.', extra: away('dave.png') }),
            at(3000, { avatar: 'bob.png', mes: 'After the join.' }),
            at(2000, { avatar: 'dave.png', mes: 'Dave speaks.' }),
        ], header([['dave.png', iso(START - 5000)]]));

        assert.deepEqual(recorder.hiddenFor('dave.png'), {
            away: 2,
            joined: 4,
            lines: [
                { index: 6, rule: 'away', excerpt: 'Whisper.' },
                { index: 5, rule: 'joined', excerpt: `${'x'.repeat(59)}😀` },
                { index: 3, rule: 'joined', excerpt: 'Carol waves at everyone, then mentions the thunderstorm roll' },
                { index: 2, rule: 'away', excerpt: 'Psst.' },
                { index: 1, rule: 'joined', excerpt: '' },
            ],
            skipped: null,
        });
        assert.deepEqual(recorder.hiddenFor('alice.png'), { away: 0, joined: 0, lines: [], skipped: null });

        const items = promptOf(fake.context.chat.filter(message => !message.is_system));
        assert.equal(recorder.filter(items, 'normal', 'dave.png'), 6);
    });

    test('reports no preview for an unresolved member', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        const off = { away: 0, joined: 0, lines: [], skipped: 'off' };
        for (const avatar of [undefined, null, '', 42]) assert.deepEqual(recorder.hiddenFor(avatar), off, String(avatar));
    });

    test('keeps preview failures out of the filter error', async () => {
        const { fake, recorder, logs } = await setup();
        await openMissed(fake);
        let notified = 0;
        recorder.subscribe(() => notified++);
        fake.context.chat.push(unreadable(new Error('unreadable extra')));

        assert.deepEqual(recorder.hiddenFor('bob.png'), { away: 0, joined: 0, lines: [], skipped: 'unavailable' });
        assert.equal(recorder.hiddenFor('carol.png').skipped, 'unavailable');
        assert.equal(recorder.status().lastError, null);
        assert.equal(notified, 0);
        assert.equal(logs.length, 1);
    });

    test('reports capabilities, switches and errors', async () => {
        const { fake, recorder } = await setup();
        assert.deepEqual(recorder.status(), {
            capable: { history: true, automatic: true },
            history: true,
            automatic: false,
            steppedAside: false,
            lastError: null,
        });
        fake.settings.update({ scene_auto: true });
        assert.equal(recorder.status().automatic, true);
        delete fake.context.eventTypes.GROUP_WRAPPER_FINISHED;
        assert.deepEqual(recorder.status().capable, { history: true, automatic: false });
        assert.equal(recorder.status().automatic, false);
        fake.settings.update({ scene_history: false });
        assert.equal(recorder.status().history, false);
    });

    test('reports automatic presence off while scene memory has no turn-on token', async () => {
        const { recorder } = await setup({ settings: { scene_auto: true, scene_history_since: null } });
        assert.equal(recorder.status().history, true);
        assert.equal(recorder.status().automatic, false);
    });
});

describe('scene recorder recording', () => {
    test('records a wrapper-sent user line and leaves the save to the host', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ avatar: 'alice.png', mes: 'Hello.', send_date: iso(START - 1000) })]);
        t.fake.setGenerating(true);
        const sent = await t.fake.sendUser('Hi.');
        assert.deepEqual(note(t.fake.context.chat[sent]), noted('bob.png'));
        assert.deepEqual(t.fake.saves, []);
        await started(t.fake);
        const reply = await t.fake.receive('alice.png', 'Hi there.');
        assert.deepEqual(note(t.fake.context.chat[reply]), noted('bob.png'));
        t.fake.setGenerating(false);
        await finished(t.fake);
        // The host saved the reply, and the user line's note with it.
        assert.deepEqual(t.fake.saves, []);

        // Nobody answered: the wrapper ends without a reply save, so the round end saves the note.
        t.fake.setGenerating(true);
        await t.fake.sendUser('Anyone?');
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.deepEqual(t.fake.saves.map(save => save.options), [{}]);
        await finished(t.fake);
        assert.equal(t.fake.saves.length, 1);
    });

    test('saves a typed /send before returning', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ avatar: 'alice.png', mes: 'Hello.', send_date: iso(START - 1000) })]);
        const done = slowSaves(t.fake);
        const chat = () => t.fake.context.chat;

        const sent = await t.fake.sendUser('Psst.');
        assert.equal(done.length, 1);
        assert.deepEqual(done[0].options, {});
        assert.deepEqual(note(done[0].chat[sent]), noted('bob.png'));

        const narrator = await push(t.fake, t.fake.message({ mes: 'The door creaks.', type: 'narrator' }), 'MESSAGE_SENT');
        assert.deepEqual(note(chat()[narrator]), noted('bob.png'));
        assert.equal(done.length, 2);

        const sendas = await t.fake.receive('carol.png', 'Hm.', 'command');
        assert.deepEqual(note(chat()[sendas]), noted('bob.png'));
        assert.deepEqual(entryNote(chat()[sendas], 0), noted('bob.png'));
        assert.equal(done.length, 3);

        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        const plain = await t.fake.sendUser('Nobody is away.');
        assert.equal(note(chat()[plain]), undefined);
        assert.equal(done.length, 3);
    });

    test('copies the neighbour\'s after-state into an inserted line, minus its author', async () => {
        const t = await setup();
        await openScene(t, [
            t.fake.message({ avatar: 'alice.png', mes: 'One.', send_date: iso(START - 2000),
                extra: { sbu_scene: { v: 1, away: ['bob.png'], moved: [['carol.png', 'present', 'absent']] } } }),
            t.fake.message({ is_user: true, mes: 'Two.', send_date: iso(START - 1000) }),
        ], { absent: [] });
        const done = slowSaves(t.fake);
        const chat = () => t.fake.context.chat;

        assert.equal(await t.fake.receive('carol.png', 'Carol, inserted.', 'command', { at: 1 }), 1);
        assert.deepEqual(note(chat()[1]), noted('bob.png'));
        assert.deepEqual(entryNote(chat()[1], 0), noted('bob.png'));
        assert.equal(done.length, 1);
        assert.deepEqual(note(done[0].chat[1]), noted('bob.png'));

        assert.equal(await t.fake.sendUser('User, inserted.', { at: 1 }), 1);
        assert.deepEqual(note(chat()[1]), noted('bob.png', 'carol.png'));
        assert.equal(done.length, 2);
        assert.equal(note(chat()[3]), undefined);
    });

    test('ignores comments and hidden lines', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ avatar: 'alice.png', mes: 'Hello.', send_date: iso(START - 1000) })]);
        const comment = t.fake.message({ mes: 'An aside.', is_system: true, type: 'comment' });
        await push(t.fake, comment, 'MESSAGE_SENT');
        const biasOnly = t.fake.message({ avatar: 'carol.png', mes: '', is_system: true });
        await push(t.fake, biasOnly, 'MESSAGE_RECEIVED', 'command');
        assert.equal(note(comment), undefined);
        assert.equal(note(biasOnly), undefined);
        assert.deepEqual(t.fake.saves, []);
        const shown = await t.fake.sendUser('Hello again.');
        assert.deepEqual(note(t.fake.context.chat[shown]), noted('bob.png'));
    });

    test('records a new reply\'s shown version and marks it read', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        await started(t.fake);
        const id = await t.fake.receive('alice.png', 'Hello.');
        const line = t.fake.context.chat[id];
        assert.deepEqual(note(line), noted('bob.png'));
        assert.deepEqual(entryNote(line, 0), noted('bob.png'));
        // An absent author still saw their own line.
        const own = await t.fake.receive('bob.png', 'I am off.');
        assert.equal(note(t.fake.context.chat[own]), undefined);

        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        assert.equal(t.scene.setState('carol.png', 'absent').ok, true);
        await t.fake.emit('MESSAGE_RECEIVED', id, 'normal');
        await finished(t.fake);
        assert.deepEqual(note(line), noted('bob.png'));
        assert.equal(note(t.fake.context.chat[own]), undefined);
    });

    test('saves after recording a greeting only when it wrote something', async () => {
        const t = await setup();
        const greeting = () => t.fake.message({ avatar: 'alice.png', mes: 'Welcome.' });
        await t.fake.openChat([greeting()]);
        await t.fake.emit('MESSAGE_RECEIVED', 0, 'first_message');
        assert.equal(note(t.fake.context.chat[0]), undefined);
        assert.deepEqual(t.fake.saves, []);

        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        const done = slowSaves(t.fake);
        // The host pushes the greeting before CHAT_CHANGED and announces it after.
        await t.fake.openChat([greeting()]);
        await t.fake.emit('MESSAGE_RECEIVED', 0, 'first_message');
        assert.deepEqual(note(t.fake.context.chat[0]), noted('bob.png'));
        assert.equal(done.length, 1);
    });

    test('drops the inherited record when a swipe generates and records the new version', async () => {
        const t = await setup();
        await openScene(t, [
            t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 2000) }),
            t.fake.message({ avatar: 'alice.png', mes: 'Old.', send_date: iso(START - 1000), extra: away('bob.png') }),
        ], { absent: [] });
        const line = t.fake.context.chat[1];
        await t.fake.swipeGenerate(1);
        assert.equal(line.mes, '...');
        assert.equal(note(line), undefined);
        assert.deepEqual(entryNote(line, 0), noted('bob.png'));

        assert.equal(t.scene.setState('carol.png', 'absent').ok, true);
        await started(t.fake, 'swipe');
        await t.fake.finishSwipe(1, 'New.', { streaming: false });
        assert.deepEqual(note(line), noted('carol.png'));
        await finished(t.fake, 'swipe');
        assert.deepEqual([entryNote(line, 0), entryNote(line, 1)], [noted('bob.png'), noted('carol.png')]);
    });

    test('tells a generating swipe by its empty slot, not by its text', async () => {
        const t = await setup();
        const silent = { name: 'Carol', is_user: false, original_avatar: 'carol.png', mes: '...', swipe_id: 0, swipes: ['...'],
            send_date: iso(START - 1500), extra: away('bob.png') };
        await openScene(t, [
            t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 2000) }),
            silent,
            t.fake.message({ avatar: 'alice.png', mes: 'Old.', send_date: iso(START - 1000), extra: away('bob.png') }),
        ], { absent: [] });
        await t.fake.emit('MESSAGE_SWIPED', 1);
        assert.deepEqual(note(silent), noted('bob.png'));

        // Upstream-style hosts show '...' only on screen and leave the old version's text in the line.
        const line = t.fake.context.chat[2];
        assert.equal(t.scene.setState('carol.png', 'absent').ok, true);
        await t.fake.swipeGenerate(2, { keepText: true });
        assert.equal(line.mes, 'Old.');
        assert.equal(note(line), undefined);
        assert.deepEqual(entryNote(line, 0), noted('bob.png'));

        // The new version is recorded when its reply arrives, not when the swipe starts.
        assert.equal(t.scene.setState('carol.png', 'present').ok, true);
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        await started(t.fake, 'swipe');
        await t.fake.finishSwipe(2, 'New.');
        assert.deepEqual(note(line), noted('bob.png'));
    });

    test('never records or saves a swipe slot that got no reply', async () => {
        const t = await setup();
        await openScene(t, [
            t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 2000) }),
            t.fake.message({ avatar: 'alice.png', mes: 'Old.', send_date: iso(START - 1000) }),
        ]);
        const line = t.fake.context.chat[1];
        // The request failed or was stopped before any reply: the round ends on the empty slot.
        await t.fake.swipeGenerate(1);
        await started(t.fake, 'swipe');
        await finished(t.fake, 'swipe');
        assert.equal(note(line), undefined);
        assert.deepEqual(t.fake.saves, []);

        t.fake.revertSwipe(1);
        assert.deepEqual([line.swipe_id, line.mes], [0, 'Old.']);
        await t.fake.swipeGenerate(1);
        await started(t.fake, 'swipe');
        await t.fake.finishSwipe(1, 'New.');
        assert.deepEqual(note(line), noted('bob.png'));
        await finished(t.fake, 'swipe');
        assert.deepEqual(entryNote(line, 1), noted('bob.png'));
    });

    test('records a new version in the slot of a version removed without an event', async () => {
        const t = await setup();
        await openScene(t, [
            t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 2000) }),
            withVersions(t.fake.message({ avatar: 'alice.png', mes: 'Old.', send_date: iso(START - 1000) }), 'Old too.'),
        ]);
        const line = t.fake.context.chat[1];
        line.swipes.splice(1, 1);
        line.swipe_info.splice(1, 1);
        await t.fake.swipeGenerate(1);
        await started(t.fake, 'swipe');
        await t.fake.finishSwipe(1, 'New.');
        assert.deepEqual(note(line), noted('bob.png'));
    });

    test('keeps read versions in step when a version is deleted', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        const id = await t.fake.receive('carol.png', 'Hi.', 'normal', { alternatives: ['Hey.', 'Yo.'] });
        const line = t.fake.context.chat[id];
        await t.fake.swipeTo(id, 2);
        assert.deepEqual(note(line), noted('bob.png'));
        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        assert.equal(t.scene.setState('alice.png', 'absent').ok, true);

        // 'Hey.' (never shown) and 'Yo.' (read) each move down one place.
        await t.fake.deleteSwipe(id, 0);
        assert.deepEqual([line.swipe_id, line.mes], [1, 'Yo.']);
        await t.fake.swipeTo(id, 0);
        assert.equal(line.mes, 'Hey.');
        assert.deepEqual(note(line), noted('alice.png'));
        await t.fake.swipeTo(id, 1);
        assert.deepEqual(note(line), noted('bob.png'));
    });

    test('mirrors a streamed reply into its swipe entry', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        const id = await t.fake.receive('alice.png', 'Streamed.');
        const line = t.fake.context.chat[id];
        assert.deepEqual(note(line), noted('bob.png'));
        assert.deepEqual(entryNote(line, 0), noted('bob.png'));
        assert.notEqual(entryNote(line, 0), note(line));

        await t.fake.swipeGenerate(id);
        await t.fake.finishSwipe(id, 'Streamed again.');
        assert.deepEqual(note(line), noted('bob.png'));
        assert.deepEqual(entryNote(line, 1), noted('bob.png'));
    });

    test('records an unread version shown by a swipe as a new reply', async () => {
        const t = await setup();
        await openScene(t, [
            t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 2000) }),
            withVersions(t.fake.message({ avatar: 'alice.png', mes: 'Loaded.', send_date: iso(START - 1000) }), 'Loaded too.'),
        ]);
        // Versions in the file when the chat opened count as read.
        await t.fake.swipeTo(1, 1);
        assert.equal(note(t.fake.context.chat[1]), undefined);

        const id = await t.fake.receive('carol.png', 'Hi.', 'normal', { alternatives: ['Hey.'] });
        const line = t.fake.context.chat[id];
        assert.deepEqual(note(line), noted('bob.png'));
        assert.equal(entryNote(line, 1), undefined);
        assert.equal(t.scene.setState('alice.png', 'absent').ok, true);
        await t.fake.swipeTo(id, 1);
        assert.deepEqual(note(line), noted('alice.png', 'bob.png'));
        assert.deepEqual(entryNote(line, 1), noted('alice.png', 'bob.png'));
        await t.fake.swipeTo(id, 0);
        assert.deepEqual(note(line), noted('bob.png'));
        assert.deepEqual(t.fake.saves, []);

        // On an older line an unread version stays unrecorded.
        const older = await t.fake.receive('carol.png', 'Again.', 'normal', { alternatives: ['Once more.'] });
        await t.fake.receive('alice.png', 'Newest.');
        await t.fake.swipeTo(older, 1);
        assert.equal(note(t.fake.context.chat[older]), undefined);
    });

    test('reads a stopped stream at round end', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        const before = await t.fake.receive('carol.png', 'Pushed before the round.', 'normal', { emitEvent: false });
        t.fake.setGenerating(true);
        await started(t.fake);
        const stopped = await t.fake.receive('alice.png', 'Stopp', 'normal', { emitEvent: false });
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.deepEqual(note(t.fake.context.chat[stopped]), noted('bob.png'));
        assert.deepEqual(entryNote(t.fake.context.chat[stopped], 0), noted('bob.png'));
        assert.equal(note(t.fake.context.chat[before]), undefined);
        assert.deepEqual(t.fake.saves.map(save => save.options), [{}]);

        // The host skips GROUP_WRAPPER_STARTED when nobody is activated; such a round reads nothing.
        const unstarted = await t.fake.receive('alice.png', 'No round.', 'normal', { emitEvent: false });
        await finished(t.fake);
        assert.equal(note(t.fake.context.chat[unstarted]), undefined);
        assert.equal(t.fake.saves.length, 1);
    });

    test('saves a reply whose stream errored at round end', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        t.fake.setGenerating(true);
        await started(t.fake);
        // The host stops the stream, then emits the reply event without its own save.
        await t.fake.emit('GENERATION_STOPPED');
        const errored = await t.fake.receive('alice.png', 'Half a');
        assert.deepEqual(note(t.fake.context.chat[errored]), noted('bob.png'));
        assert.equal(t.fake.saves.length, 0);
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.deepEqual(t.fake.saves.map(save => save.options), [{}]);

        // A stream that finished leaves the save to the host.
        t.fake.setGenerating(true);
        await started(t.fake);
        await t.fake.receive('carol.png', 'Whole.');
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(t.fake.saves.length, 1);

        // A stop after a reply the host saved could be that reply's error seen late, so the round saves once more.
        t.fake.setGenerating(true);
        await started(t.fake);
        await t.fake.receive('carol.png', 'Whole.');
        await t.fake.emit('GENERATION_STOPPED');
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(t.fake.saves.length, 2);

        // A stop in a round that wrote nothing saves nothing.
        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        t.fake.setGenerating(true);
        await started(t.fake);
        await t.fake.emit('GENERATION_STOPPED');
        await t.fake.receive('alice.png', 'Nobody is away.');
        await t.fake.emit('GENERATION_STOPPED');
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(t.fake.saves.length, 2);
    });

    test('a continue can only shrink away, also when its stream stopped', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })],
            { absent: ['bob.png', 'carol.png'] });
        const id = await t.fake.receive('alice.png', 'Once');
        const line = t.fake.context.chat[id];
        assert.deepEqual(note(line), noted('bob.png', 'carol.png'));

        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        await t.fake.continueLine(id, ' upon a time.');
        assert.deepEqual(note(line), noted('carol.png'));
        assert.deepEqual(entryNote(line, 0), noted('carol.png'));
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        await t.fake.continueLine(id, ' More.', { streaming: false });
        assert.deepEqual(note(line), noted('carol.png'));

        assert.equal(t.scene.setState('carol.png', 'present').ok, true);
        await started(t.fake, 'continue');
        await t.fake.continueLine(id, ' Stopp', { emitEvent: false });
        await finished(t.fake, 'continue');
        assert.equal(note(line), undefined);
        assert.equal(entryNote(line, 0), undefined);
        assert.equal(t.fake.saves.length, 1);
    });

    test('strips copies from alternatives made this round', async () => {
        const t = await setup();
        const loaded = withVersions(t.fake.message({ avatar: 'alice.png', mes: 'Old.', send_date: iso(START - 1000),
            extra: away('carol.png') }), 'Old too.');
        loaded.swipe_info[1].extra = away('carol.png');
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 2000) }), loaded]);
        const line = t.fake.context.chat[1];

        await t.fake.swipeGenerate(1);
        await started(t.fake, 'swipe');
        await t.fake.finishSwipe(1, 'New.', { streaming: false, alternatives: ['Alt A.', 'Alt B.'] });
        assert.deepEqual(entryNote(line, 3), noted('bob.png'));
        await finished(t.fake, 'swipe');
        assert.deepEqual(line.swipe_info.map(entry => entry.extra.sbu_scene),
            [noted('carol.png'), noted('carol.png'), noted('bob.png'), undefined, undefined]);
        assert.equal(t.fake.saves.length, 1);

        await started(t.fake);
        const id = await t.fake.receive('carol.png', 'Reply.', 'normal', { streaming: false, alternatives: ['Other.'] });
        assert.deepEqual(entryNote(t.fake.context.chat[id], 1), noted('bob.png'));
        await finished(t.fake);
        assert.deepEqual(t.fake.context.chat[id].swipe_info.map(entry => entry.extra.sbu_scene), [noted('bob.png'), undefined]);
        assert.equal(t.fake.saves.length, 2);
    });

    test('flushes unsaved changes after a quiet round', async () => {
        for (const type of ['quiet', 'impersonate']) {
            const t = await setup();
            await openScene(t, lines3(t.fake), { absent: [] });
            t.fake.setGenerating(true);
            await started(t.fake, type);
            await t.fake.addMember('dave.png');
            assert.deepEqual(t.fake.saves, [], type);
            t.fake.setGenerating(false);
            await finished(t.fake, type);
            assert.equal(t.fake.saves.length, 1, type);
            assert.deepEqual(t.fake.saves[0].metadata[ROSTER_KEY].joined, [['dave.png', iso(START - 1000)]], type);
            await finished(t.fake, type);
            assert.equal(t.fake.saves.length, 1, type);
        }
    });

    test('never saves when a chat opens', async () => {
        const fake = await createFakeHost({ members: WITH_DAVE });
        fake.context.chat = lines3(fake);
        const t = attach(fake);
        assert.deepEqual(fake.context.chatMetadata[ROSTER_KEY].known, WITH_DAVE);

        // Dave is new to this file's roster, and one note cannot be read.
        const lines = lines3(fake);
        lines[0].extra = { sbu_scene: { v: 1, away: 'bob.png' } };
        await fake.openChat(lines, header([]));
        assert.deepEqual(fake.context.chatMetadata[ROSTER_KEY].joined, [['dave.png', iso(START - 1000)]]);
        assert.deepEqual(fake.shownToasts(), [withUndo({ level: 'info', text: SCENE_TEXT.P25, detail: 'Dave (3)' }),
            { level: 'warning', text: SCENE_TEXT.P15 }]);

        fake.settings.update({ scene_history: false, scene_history_since: null });
        fake.settings.update({ scene_history: true, scene_history_since: NEW_TOKEN });
        assert.equal(fake.context.chatMetadata[ROSTER_KEY].since, NEW_TOKEN);
        assert.equal(t.recorder.status().history, true);
        assert.deepEqual(fake.saves, []);
    });

    test('passes allowShrink to a save right after a delete', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake));
        t.fake.context.chat.pop();
        await t.fake.emit('MESSAGE_DELETED', t.fake.context.chat.length);
        await t.fake.sendUser('Right after.');
        await t.fake.sendUser('Later.');
        assert.deepEqual(t.fake.saves.map(save => save.options), [{ allowShrink: true }, {}]);
    });

    test('resets round state and seeds the read set on chat change', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        t.fake.setGenerating(true);
        await t.fake.sendUser('Hi.');
        await started(t.fake);
        const loaded = () => [
            t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 2000) }),
            withVersions(t.fake.message({ avatar: 'alice.png', mes: 'Loaded.', send_date: iso(START - 1000) }), 'Loaded too.'),
        ];
        await t.fake.openChat(loaded());
        const id = await t.fake.receive('carol.png', 'Unannounced.', 'normal', { emitEvent: false });
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(note(t.fake.context.chat[id]), undefined);
        assert.deepEqual(t.fake.saves, []);

        await t.fake.openChat(loaded());
        await t.fake.swipeTo(1, 1);
        assert.equal(note(t.fake.context.chat[1]), undefined);
        // A round that starts in the new chat reads its own stopped stream.
        await started(t.fake);
        const stopped = await t.fake.receive('carol.png', 'Stopp', 'normal', { emitEvent: false });
        await finished(t.fake);
        assert.deepEqual(note(t.fake.context.chat[stopped]), noted('bob.png'));
    });

    test('warns once per chat about unreadable notes', async () => {
        const t = await setup();
        const odd = () => [t.fake.message({ avatar: 'alice.png', mes: 'Odd.', extra: { sbu_scene: { v: 1, away: 'bob.png' } } })];
        const warning = { level: 'warning', text: SCENE_TEXT.P15 };
        await t.fake.openChat(odd());
        await t.fake.openChat(odd());
        assert.deepEqual(t.fake.shownToasts(), [warning]);
        assert.deepEqual(note(t.fake.context.chat[0]), { v: 1, away: 'bob.png' });

        switchChat(t.fake, 'c2');
        await t.fake.openChat(odd());
        assert.deepEqual(t.fake.shownToasts(), [warning, warning]);

        t.fake.settings.update({ scene_history: false });
        switchChat(t.fake, 'c3');
        await t.fake.openChat(odd());
        assert.equal(t.fake.toasts.length, 2);
        t.fake.settings.update({ scene_history: true });
        assert.deepEqual(t.fake.shownToasts(), [warning, warning, warning]);
    });

    test('saves after every creation-event write when the host cannot report generating', async () => {
        const t = await setup();
        t.fake.setGenerating(undefined);
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        await t.fake.sendUser('Hi.');
        await t.fake.receive('alice.png', 'Hello.');
        assert.equal(t.fake.saves.length, 2);
        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        await t.fake.receive('carol.png', 'Nobody is away.');
        assert.equal(t.fake.saves.length, 2);

        t.fake.setGenerating(false);
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        await t.fake.receive('alice.png', 'The host saves this one.');
        assert.equal(t.fake.saves.length, 2);
    });

    test('reads only lines written while scene memory was on when it turns off mid-round', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        await started(t.fake);
        t.fake.settings.update({ scene_history: false });
        const off = await t.fake.receive('alice.png', 'While off.');
        t.fake.settings.update({ scene_history: true });
        const stopped = await t.fake.receive('carol.png', 'Stopp', 'normal', { emitEvent: false });
        await finished(t.fake);
        assert.equal(note(t.fake.context.chat[off]), undefined);
        assert.deepEqual(note(t.fake.context.chat[stopped]), noted('bob.png'));

        await started(t.fake);
        const late = await t.fake.receive('alice.png', 'Stopp', 'normal', { emitEvent: false });
        t.fake.settings.update({ scene_history: false });
        await finished(t.fake);
        assert.equal(note(t.fake.context.chat[late]), undefined);
    });

    test('tolerates messages without extra or swipe_info', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        const bare = { name: 'Alice', is_user: false, original_avatar: 'alice.png', mes: 'Bare.', send_date: iso(START) };
        await push(t.fake, bare, 'MESSAGE_RECEIVED', 'normal');
        assert.deepEqual(bare.extra, { sbu_scene: noted('bob.png') });

        const odd = { is_user: true, mes: 42, extra: null, swipe_id: 9, swipe_info: [] };
        await push(t.fake, odd, 'MESSAGE_SENT');
        assert.deepEqual(odd.extra, { sbu_scene: noted('bob.png') });
        assert.deepEqual(odd.swipe_info, []);
        await t.fake.emit('MESSAGE_SWIPED', t.fake.context.chat.length - 1);

        await t.fake.emit('MESSAGE_RECEIVED', 99, 'normal');
        await t.fake.emit('MESSAGE_SENT', -1);
        await t.fake.emit('MESSAGE_SWIPED', 'x');
        await started(t.fake, 'swipe');
        t.fake.context.chat.push(null, 42);
        await t.fake.emit('MESSAGE_RECEIVED', t.fake.context.chat.length - 1, 'continue');
        await finished(t.fake, 'swipe');
        assert.deepEqual(t.logs, []);
    });
});

describe('scene recorder join wiring', () => {
    test('keeps a line written after an unannounced add visible to the newcomer', async () => {
        const openedLater = async () => {
            const t = await setup();
            await t.fake.openChat(lines3(t.fake), header([]));
            return t;
        };
        // GCO started with the chat already open: the init check reads the file instead.
        const openBefore = async () => {
            const fake = await createFakeHost();
            fake.context.chat = lines3(fake);
            fake.context.chatMetadata = header([]);
            return attach(fake);
        };
        for (const open of [openedLater, openBefore]) {
            const t = await open();
            await t.fake.addMember('dave.png', { event: false });
            t.fake.clock.tick();
            t.fake.context.chat.push(t.fake.message({ avatar: 'alice.png', mes: 'After the add.' }));
            const items = promptOf(t.fake.context.chat);
            assert.equal(t.recorder.filter(items, 'normal', 'dave.png'), 3, open.name);
            assert.deepEqual(items.map(item => item.mes), ['', '', '', 'After the add.'], open.name);
        }
    });

    test('clears the filter error when the chat changes', async () => {
        const { fake, recorder } = await setup();
        await openMissed(fake);
        let notified = 0;
        recorder.subscribe(() => notified++);
        recorder.filter([...promptOf(fake.context.chat), unreadable(new Error('unreadable extra'))], 'normal', 'bob.png');
        assert.match(recorder.status().lastError, /unreadable extra/);
        assert.equal(notified, 1);

        await openMissed(fake);
        assert.equal(recorder.status().lastError, null);
        assert.equal(notified, 2);
        await openMissed(fake);
        assert.equal(notified, 2);
    });

    test('saves a join found at a send before returning, during a round too', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake));
        await t.fake.addMember('dave.png', { event: false });
        t.fake.setGenerating(true);
        const done = slowSaves(t.fake);
        // The note alone would wait for the host's reply save; the join makes the one save happen now.
        const id = await t.fake.sendUser('Hi all.');
        assert.equal(done.length, 1);
        assert.deepEqual(done[0].metadata[ROSTER_KEY].joined, [['dave.png', iso(START - 1000)]]);
        assert.deepEqual(note(done[0].chat[id]), noted('bob.png'));
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(done.length, 1);
    });

    test('clamps a join when a newer line is dated earlier', async () => {
        const t = await setup({ members: WITH_DAVE });
        await t.fake.openChat(lines3(t.fake), header([['dave.png', iso(START + 60_000)]]));
        const sent = await t.fake.sendUser('Hi.');
        const sentAt = Date.parse(t.fake.context.chat[sent].send_date);
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, [['dave.png', iso(sentAt - 1)]]);
        assert.equal(t.fake.saves.length, 1);

        t.fake.context.chatMetadata[ROSTER_KEY] = header([['dave.png', iso(START + 60_000)]])[ROSTER_KEY];
        const quiet = await t.fake.receive('alice.png', 'Aside.', 'quiet');
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, [['dave.png', iso(START + 60_000)]]);
        const reply = await t.fake.receive('alice.png', 'Hello.');
        const replyAt = Date.parse(t.fake.context.chat[reply].send_date);
        assert.ok(replyAt > Date.parse(t.fake.context.chat[quiet].send_date));
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, [['dave.png', iso(replyAt - 1)]]);
    });

    test('checks joins when a generation starts and saves them at round end', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [] });
        await t.fake.addMember('dave.png', { event: false });
        t.fake.setGenerating(true);
        await t.fake.emit('GENERATION_STARTED', 'normal', {}, false);
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, [['dave.png', iso(START - 1000)]]);
        assert.deepEqual(t.fake.saves, []);
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(t.fake.saves.length, 1);
    });

    test('saves a join from the editor at once when the host is idle', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [] });
        await t.fake.addMember('dave.png');
        assert.equal(t.fake.saves.length, 1);
        assert.deepEqual(t.fake.saves[0].metadata[ROSTER_KEY].joined, [['dave.png', iso(START - 1000)]]);
    });

    test('adopts the header at the first message event', async () => {
        const fake = await createFakeHost();
        fake.context.chat = lines3(fake);
        fake.context.chatMetadata = header([]);
        const t = attach(fake);
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        await fake.addMember('dave.png');
        assert.deepEqual(fake.context.chatMetadata[ROSTER_KEY].joined, [['dave.png', iso(START - 1000)]]);
        assert.deepEqual(fake.saves, []);

        await fake.sendUser('Hi.');
        assert.equal(fake.saves.length, 1);
        assert.deepEqual(fake.saves[0].metadata[ROSTER_KEY].joined, [['dave.png', iso(START - 1000)]]);
    });

    test('runs the join check when scene memory turns on, without saving', async () => {
        const t = await setup({ settings: { scene_history: false, scene_history_since: null } });
        await t.fake.openChat(lines3(t.fake));
        assert.equal(Object.hasOwn(t.fake.context.chatMetadata, ROSTER_KEY), false);
        t.fake.settings.update({ scene_history: true, scene_history_since: TOKEN });
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].known, FOUNDERS);
        assert.equal(t.fake.context.chatMetadata[ROSTER_KEY].since, TOKEN);
        t.fake.settings.update({ scene_history_since: NEW_TOKEN });
        assert.equal(t.fake.context.chatMetadata[ROSTER_KEY].since, NEW_TOKEN);
        assert.deepEqual(t.fake.saves, []);
    });

    test('warns once per chat about unreadable and foreign rosters', async () => {
        const t = await setup();
        const broken = () => ({ integrity: 'fake-integrity', [ROSTER_KEY]: { v: 1, group: '' } });
        await t.fake.openChat(lines3(t.fake), broken());
        await t.fake.openChat(lines3(t.fake), broken());
        assert.deepEqual(t.fake.shownToasts(), [{ level: 'warning', text: SCENE_TEXT.P27 }]);

        switchChat(t.fake, 'c2');
        await t.fake.openChat(lines3(t.fake), { integrity: 'fake-integrity', [ROSTER_KEY]: { v: 2 } });
        await t.fake.openChat(lines3(t.fake), { integrity: 'fake-integrity', [ROSTER_KEY]: { v: 2 } });
        assert.deepEqual(t.fake.shownToasts(), [{ level: 'warning', text: SCENE_TEXT.P27 }, { level: 'warning', text: SCENE_TEXT.P28 }]);
    });

    test('renames the roster in a past chat and leaves the save to the host', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [] });
        t.fake.context.groupId = null;
        const roster = { v: 1, group: 'g1', since: TOKEN, floor: null, known: WITH_DAVE, gone: [],
            joined: [['dave.png', iso(START - 5000)]] };
        const messages = [{ chat_metadata: { integrity: 'other', [ROSTER_KEY]: roster } },
            { name: 'Dave', mes: 'Hi.', original_avatar: 'dave.png' }];
        await t.fake.emit('CHARACTER_RENAMED_IN_PAST_CHAT', messages, 'dave.png', 'david.png');
        assert.deepEqual(messages[0].chat_metadata[ROSTER_KEY].known, [...FOUNDERS, 'david.png']);
        assert.deepEqual(messages[0].chat_metadata[ROSTER_KEY].joined, [['david.png', iso(START - 5000)]]);
        assert.deepEqual(t.fake.saves, []);
    });

    test('renames the avatar in a past chat\'s notes while scene memory is on', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [] });
        t.fake.context.groupId = null;
        const line = { name: 'Alice', mes: 'Dave heads out.', original_avatar: 'alice.png', swipe_id: 0,
            extra: { sbu_scene: { v: 1, away: ['bob.png', 'dave.png'], moved: [['dave.png', 'present', 'absent']],
                undone: ['dave.png'] } },
            swipe_info: [{ extra: { sbu_scene: { v: 1, away: ['dave.png'] } } },
                { extra: { sbu_scene: { v: 1, away: ['dave.png', 'zed.png'] } } }] };
        const unknown = { name: 'Bob', mes: 'Hm.', original_avatar: 'bob.png', extra: { sbu_scene: { v: 2, away: ['dave.png'] } } };
        const messages = [{ chat_metadata: { integrity: 'other' } }, line, unknown];
        await t.fake.emit('CHARACTER_RENAMED_IN_PAST_CHAT', messages, 'dave.png', 'david.png');
        assert.deepEqual(line.extra.sbu_scene, { v: 1, away: ['bob.png', 'david.png'],
            moved: [['david.png', 'present', 'absent']], undone: ['david.png'] });
        assert.deepEqual(line.swipe_info[0].extra.sbu_scene, { v: 1, away: ['david.png'] });
        assert.deepEqual(line.swipe_info[1].extra.sbu_scene, { v: 1, away: ['david.png', 'zed.png'] });
        assert.deepEqual(unknown.extra.sbu_scene, { v: 2, away: ['dave.png'] });
        assert.deepEqual(t.fake.saves, []);

        t.fake.settings.update({ scene_history: false });
        await t.fake.emit('CHARACTER_RENAMED_IN_PAST_CHAT', messages, 'david.png', 'dave.png');
        assert.deepEqual(line.swipe_info[0].extra.sbu_scene, { v: 1, away: ['david.png'] });
    });

    test('stops listening once destroyed', async () => {
        const t = await setup();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })]);
        t.recorder.destroy();
        const id = await t.fake.sendUser('Hi.');
        assert.equal(note(t.fake.context.chat[id]), undefined);
        t.fake.settings.update({ scene_history: false, scene_history_since: null });
        t.fake.settings.update({ scene_history: true, scene_history_since: NEW_TOKEN });
        assert.equal(t.fake.context.chatMetadata[ROSTER_KEY].since, TOKEN);
        assert.deepEqual(t.fake.saves, []);
    });
});

describe('scene recorder automatic presence', () => {
    const auto = (options = {}) => setup({ ...options, settings: { scene_auto: true, ...options.settings } });
    const rows = t => t.recorder.getChanges().map(({ id, ...row }) => {
        assert.equal(typeof id, 'string');
        return row;
    });

    test('applies a change in a typed or natively routed line at once', async () => {
        const t = await auto();
        await openScene(t, lines3(t.fake), { absent: ['carol.png'] });
        const chat = () => t.fake.context.chat;

        const sent = await t.fake.sendUser('Bob leaves.');
        assert.deepEqual(note(chat()[sent]), { v: 1, away: ['carol.png'], moved: [['bob.png', 'unspecified', 'absent']] });
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        const sendas = await t.fake.receive('alice.png', 'Carol walks in.', 'command');
        assert.deepEqual(note(chat()[sendas]), { v: 1, away: ['bob.png'], moved: [['carol.png', 'absent', 'present']] });
        assert.deepEqual(entryNote(chat()[sendas], 0), note(chat()[sendas]));
        assert.equal(statusOf(t, 'carol.png'), 'present');
        assert.deepEqual(t.fake.shownToasts(), [applied, applied]);
        assert.deepEqual(rows(t), [
            { avatar: 'bob.png', name: 'Bob', from: 'unspecified', to: 'absent', index: 3, excerpt: 'Bob leaves.', pending: false },
            { avatar: 'carol.png', name: 'Carol', from: 'absent', to: 'present', index: 4, excerpt: 'Carol walks in.',
                pending: false },
        ]);
        const ids = t.recorder.getChanges().map(change => change.id);
        assert.notEqual(ids[0], ids[1]);

        // Native routing: the wrapper sends the line, but no routed plan ran, so nothing waits for the round.
        t.fake.setGenerating(true);
        await t.fake.sendUser('Bob comes back.');
        assert.equal(statusOf(t, 'bob.png'), 'present');
        assert.equal(t.fake.toasts.length, 3);
    });

    test('attaches planned changes to the sent line and queues the rest', async () => {
        const t = await auto();
        await openScene(t, lines3(t.fake), { absent: ['alice.png'] });
        t.recorder.prepareTurn({ text: 'Alice walks in.', key: keyOf(t) });
        assert.equal(statusOf(t, 'alice.png'), 'present');
        assert.deepEqual(t.fake.shownToasts(), [applied]);

        t.fake.setGenerating(true);
        // A macro expanded after the plan ran: the sent text names Bob too.
        const id = await t.fake.sendUser('Alice walks in. Bob leaves.');
        assert.deepEqual(note(t.fake.context.chat[id]),
            { v: 1, moved: [['alice.png', 'absent', 'present'], ['bob.png', 'unspecified', 'absent']] });
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.deepEqual(rows(t).map(({ avatar, pending }) => [avatar, pending]), [['alice.png', false], ['bob.png', true]]);

        await started(t.fake);
        await t.fake.receive('carol.png', 'Evening.');
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.deepEqual([statusOf(t, 'alice.png'), statusOf(t, 'bob.png')], ['present', 'absent']);
        assert.deepEqual(t.fake.shownToasts(), [applied, applied]);
        assert.deepEqual(rows(t).map(({ avatar, pending }) => [avatar, pending]), [['alice.png', false], ['bob.png', false]]);
    });

    test('takes back planned changes that no line carried', async () => {
        const t = await auto();
        await openScene(t, lines3(t.fake), { absent: ['alice.png'] });
        t.recorder.prepareTurn({ text: 'Alice walks in.', key: keyOf(t) });
        assert.equal(statusOf(t, 'alice.png'), 'present');
        // A bias-only send emits no MESSAGE_SENT.
        t.fake.setGenerating(true);
        await started(t.fake);
        await t.fake.receive('carol.png', 'Evening.');
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(statusOf(t, 'alice.png'), 'absent');
        assert.deepEqual(t.fake.shownToasts(), [applied]);

        t.recorder.prepareTurn({ text: 'Alice walks in.', key: JSON.stringify(['g1', 'another chat']) });
        t.recorder.prepareTurn({ text: 42, key: keyOf(t) });
        assert.equal(statusOf(t, 'alice.png'), 'absent');
        assert.equal(t.fake.toasts.length, 1);
    });

    test('notes later lines of a round as if a queued change had happened', async () => {
        const t = await auto();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })], { absent: [] });
        const chat = () => t.fake.context.chat;
        await started(t.fake);
        const left = await t.fake.receive('alice.png', 'Bob heads out.');
        const after = await t.fake.receive('carol.png', 'Quiet now.');
        assert.deepEqual(note(chat()[left]), { v: 1, moved: [['bob.png', 'unspecified', 'absent']] });
        assert.deepEqual(note(chat()[after]), noted('bob.png'));
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.deepEqual(rows(t), [
            { avatar: 'bob.png', name: 'Bob', from: 'unspecified', to: 'absent', index: 1, excerpt: 'Bob heads out.', pending: true },
        ]);

        // Bob still sees his own line, and his return is read against the queued departure.
        const back = await t.fake.receive('bob.png', 'Bob comes back.');
        assert.deepEqual(note(chat()[back]), { v: 1, moved: [['bob.png', 'absent', 'present']] });
        const last = await t.fake.receive('carol.png', 'Welcome back.');
        assert.equal(note(chat()[last]), undefined);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.deepEqual(t.fake.shownToasts(), []);

        await finished(t.fake);
        assert.equal(statusOf(t, 'bob.png'), 'present');
        assert.deepEqual(t.fake.shownToasts(), [applied]);
        assert.deepEqual(rows(t).map(({ index, pending }) => [index, pending]), [[3, false]]);
    });

    test('drops queued and planned changes when automatic presence is switched off mid-round', async () => {
        const switches = fake => [
            ['automatic off and on', () => fake.settings.update({ scene_auto: false }),
                () => fake.settings.update({ scene_auto: true })],
            ['memory off and on', () => fake.settings.update({ scene_history: false }),
                () => fake.settings.update({ scene_history: true })],
            ['scene controls off', () => fake.settings.update({ scene_controls: false }), () => {}],
            ['wrapper events gone', () => delete fake.context.eventTypes.GROUP_WRAPPER_STARTED, () => {}],
        ];
        for (let which = 0; which < 4; which++) {
            const t = await auto();
            const [label, off, on] = switches(t.fake)[which];
            await openScene(t, lines3(t.fake), { absent: ['alice.png'] });
            t.recorder.prepareTurn({ text: 'Alice walks in.', key: keyOf(t) });
            t.fake.setGenerating(true);
            await started(t.fake);
            await t.fake.receive('carol.png', 'Bob heads out.');
            assert.equal(rows(t).at(-1).pending, true, label);

            off();
            on();
            t.fake.setGenerating(false);
            await finished(t.fake);
            assert.deepEqual([statusOf(t, 'alice.png'), statusOf(t, 'bob.png')], ['present', 'unspecified'], label);
            assert.deepEqual(t.fake.shownToasts(), [applied], label);
            assert.equal(t.recorder.getChanges().some(change => change.pending), false, label);
        }
    });

    test('drops what waits when the chat changes mid-round', async () => {
        const t = await auto();
        await openScene(t, lines3(t.fake), { absent: ['alice.png'] });
        t.recorder.prepareTurn({ text: 'Alice walks in.', key: keyOf(t) });
        await started(t.fake);
        await t.fake.receive('carol.png', 'Bob heads out.');
        switchChat(t.fake, 'c2');
        await t.fake.openChat(lines3(t.fake));
        switchChat(t.fake, 'c1');
        await t.fake.openChat(lines3(t.fake));
        await finished(t.fake);
        assert.deepEqual([statusOf(t, 'alice.png'), statusOf(t, 'bob.png')], ['present', 'unspecified']);
        assert.deepEqual(t.fake.shownToasts(), [applied]);
    });

    test('holds the drain until every hold is released', async () => {
        const t = await auto();
        await openScene(t, lines3(t.fake), { absent: [] });
        const first = t.recorder.hold();
        const second = t.recorder.hold();
        await started(t.fake);
        await t.fake.receive('alice.png', 'Bob heads out.');
        await finished(t.fake);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        first();
        first();
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        second();
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        assert.deepEqual(t.fake.shownToasts(), [applied]);

        // While an Ask runs, a typed line's change waits too.
        const third = t.recorder.hold();
        await t.fake.sendUser('Bob comes back.');
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        third();
        assert.equal(statusOf(t, 'bob.png'), 'present');
        assert.equal(t.fake.toasts.length, 2);
    });

    test('never detects in quiet results, impersonation drafts or loaded history', async () => {
        const t = await auto();
        const chat = () => t.fake.context.chat;
        await openScene(t, [
            t.fake.message({ avatar: 'alice.png', mes: 'Bob leaves.', send_date: iso(START - 2000) }),
            t.fake.message({ is_user: true, mes: 'Carol leaves.', send_date: iso(START - 1000) }),
        ], { absent: [] });
        t.fake.settings.update({ scene_history: false });
        t.fake.settings.update({ scene_history: true });

        await t.fake.receive('alice.png', 'Bob leaves.', 'quiet');
        await t.fake.receive('alice.png', 'Bob leaves.', 'impersonate');
        for (const type of ['quiet', 'impersonate']) {
            await started(t.fake, type);
            await t.fake.receive('alice.png', 'Bob leaves.', 'normal', { emitEvent: false });
            await finished(t.fake, type);
        }
        await push(t.fake, t.fake.message({ mes: 'Bob leaves.', is_system: true, type: 'comment' }), 'MESSAGE_SENT');
        await push(t.fake, t.fake.message({ avatar: 'carol.png', mes: 'Bob leaves.', is_system: true }),
            'MESSAGE_RECEIVED', 'command');
        await t.fake.sendUser('Bob leaves.', { at: 1 });
        await t.fake.receive('carol.png', 'Bob leaves.', 'command', { at: 1 });
        // A greeting is the card's opening text, not something happening in the scene.
        await push(t.fake, t.fake.message({ avatar: 'carol.png', mes: 'Bob leaves.' }), 'MESSAGE_RECEIVED', 'first_message');

        assert.deepEqual(statusesOf(t), { 'alice.png': 'unspecified', 'bob.png': 'unspecified', 'carol.png': 'unspecified' });
        assert.deepEqual(t.fake.shownToasts(), []);
        assert.equal(chat().some(line => note(line)?.moved), false);
        assert.deepEqual(t.recorder.getChanges(), []);
    });

    test('detects nothing while automatic presence is off or unavailable', async () => {
        const cases = [
            [{ scene_auto: false }, () => {}],
            [{ scene_history_since: null }, () => {}],
            [{}, fake => delete fake.context.eventTypes.GROUP_WRAPPER_STARTED],
        ];
        for (const [settings, change] of cases) {
            const t = await auto({ settings });
            await openScene(t, lines3(t.fake), { absent: ['carol.png'] });
            change(t.fake);
            t.recorder.prepareTurn({ text: 'Carol walks in.', key: keyOf(t) });
            const id = await t.fake.sendUser('Bob leaves.');
            await started(t.fake);
            await t.fake.receive('alice.png', 'Carol walks in.');
            await finished(t.fake);
            assert.deepEqual(note(t.fake.context.chat[id]), noted('carol.png'), JSON.stringify(settings));
            assert.deepEqual([statusOf(t, 'bob.png'), statusOf(t, 'carol.png')], ['unspecified', 'absent'], JSON.stringify(settings));
            assert.deepEqual(t.fake.shownToasts(), [], JSON.stringify(settings));
        }
    });

    test('a continue queues only changes its line does not list yet', async () => {
        const t = await auto();
        const undone = t.fake.message({ avatar: 'alice.png', mes: 'Carol walks in.', send_date: iso(START - 1000),
            extra: { sbu_scene: { v: 1, undone: ['carol.png'] } } });
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 2000) }), undone],
            { absent: ['carol.png'] });
        const chat = () => t.fake.context.chat;

        // The user undid Carol's arrival on this line; continuing it never brings that back.
        await started(t.fake, 'continue');
        await t.fake.continueLine(1, ' Then Bob leaves.');
        assert.deepEqual(note(chat()[1]), { v: 1, moved: [['bob.png', 'unspecified', 'absent']], undone: ['carol.png'] });
        await finished(t.fake, 'continue');
        assert.deepEqual([statusOf(t, 'bob.png'), statusOf(t, 'carol.png')], ['absent', 'absent']);

        await started(t.fake);
        const id = await t.fake.receive('alice.png', 'Bob comes back.');
        await t.fake.continueLine(id, ' Carol walks in.');
        assert.deepEqual(note(chat()[id]).moved, [['bob.png', 'absent', 'present'], ['carol.png', 'absent', 'present']]);
        await finished(t.fake);
        assert.deepEqual([statusOf(t, 'bob.png'), statusOf(t, 'carol.png')], ['present', 'present']);
        assert.deepEqual(t.fake.shownToasts(), [applied, applied]);
    });

    test('reads changes in a stopped stream and in an unread version', async () => {
        const t = await auto();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })], { absent: [] });
        const chat = () => t.fake.context.chat;
        await started(t.fake);
        const stopped = await t.fake.receive('alice.png', 'Bob heads out.', 'normal', { emitEvent: false });
        await finished(t.fake);
        assert.deepEqual(note(chat()[stopped]).moved, [['bob.png', 'unspecified', 'absent']]);
        assert.equal(statusOf(t, 'bob.png'), 'absent');

        const id = await t.fake.receive('carol.png', 'Hi.', 'normal', { alternatives: ['Bob comes back.'] });
        await t.fake.swipeTo(id, 1);
        assert.deepEqual(note(chat()[id]), { v: 1, moved: [['bob.png', 'absent', 'present']] });
        assert.equal(statusOf(t, 'bob.png'), 'present');
        assert.deepEqual(t.fake.shownToasts(), [applied, applied]);
    });

    test('applies a queued change only while its line lists it and the live status allows it', async () => {
        const t = await auto();
        await openScene(t, [t.fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })], { absent: [] });
        const chat = () => t.fake.context.chat;
        await started(t.fake);
        const gone = await t.fake.receive('alice.png', 'Carol heads out.');
        await t.fake.receive('carol.png', 'Bob heads out.');
        const swiped = await t.fake.receive('bob.png', 'Alice heads out.', 'normal', { alternatives: ['Hm.'] });
        // Deleted, marked remote by hand, and swiped to another version while the round runs.
        chat().splice(gone, 1);
        await t.fake.emit('MESSAGE_DELETED', gone);
        assert.equal(t.scene.setState('bob.png', 'remote').ok, true);
        await t.fake.swipeTo(swiped - 1, 1);
        await finished(t.fake);
        assert.deepEqual(statusesOf(t), { 'alice.png': 'unspecified', 'bob.png': 'remote', 'carol.png': 'unspecified' });
        assert.deepEqual(t.fake.shownToasts(), []);
    });

    test('reads members by their Reply Rules aliases, and first person only as a character\'s author', async () => {
        const t = await auto({ settings: { reply_rules: { characters: { 'alice.png': { aliases: ['Ally'] } } } } });
        await openScene(t, lines3(t.fake), { absent: ['alice.png'] });
        await t.fake.sendUser('Ally walks in.');
        assert.equal(statusOf(t, 'alice.png'), 'present');

        await t.fake.sendUser('I head out.');
        await push(t.fake, t.fake.message({ mes: 'I head out.', type: 'narrator' }), 'MESSAGE_SENT');
        assert.deepEqual(statusesOf(t), { 'alice.png': 'present', 'bob.png': 'unspecified', 'carol.png': 'unspecified' });
        await t.fake.receive('carol.png', 'I head out.', 'command');
        assert.equal(statusOf(t, 'carol.png'), 'absent');

        // A member who shares the persona's name is never read from text.
        t.fake.context.name1 = 'Bob';
        await t.fake.sendUser('Bob leaves.');
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
    });

    test('a detector error changes nothing', async () => {
        const fake = await createFakeHost({ settings: { scene_auto: true } });
        const t = attach(fake, { detect: () => { throw new Error('detector broke'); } });
        await openScene(t, lines3(fake), { absent: ['carol.png'] });
        t.recorder.prepareTurn({ text: 'Carol walks in.', key: keyOf(t) });
        const id = await fake.sendUser('Bob leaves.');
        assert.deepEqual(note(fake.context.chat[id]), noted('carol.png'));
        assert.deepEqual([statusOf(t, 'bob.png'), statusOf(t, 'carol.png')], ['unspecified', 'absent']);
        assert.deepEqual(fake.shownToasts(), []);
        assert.equal(t.logs.length, 1);
    });

    const hello = fake => [fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })];

    test('names a member\'s departure and return on one line apart', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = () => t.fake.context.chat;
        const ids = () => new Set(t.recorder.getChanges().map(change => change.id));

        // Auto-continue in a native round: both changes wait on the same line.
        await started(t.fake);
        const both = await t.fake.receive('alice.png', 'Bob heads out.');
        await t.fake.continueLine(both, ' Later, Bob comes back.');
        assert.deepEqual(note(chat()[both]).moved, [['bob.png', 'unspecified', 'absent'], ['bob.png', 'absent', 'present']]);
        assert.deepEqual(rows(t).map(({ to, pending }) => [to, pending]), [['absent', true], ['present', true]]);
        assert.equal(ids().size, 2);
        await finished(t.fake);

        // A Continue round on a line whose departure already applied.
        const left = await t.fake.receive('carol.png', 'Bob heads out.', 'command');
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        await started(t.fake, 'continue');
        await t.fake.continueLine(left, ' Then Bob comes back.');
        assert.deepEqual(rows(t).map(({ index, to, pending }) => [index, to, pending]),
            [[left, 'absent', false], [left, 'present', true]]);
        assert.equal(ids().size, 2);
    });

    test('takes a change that never applies back out of the notes, so it hides nothing', async () => {
        const cases = [
            ['automatic off', 'unspecified', t => t.fake.settings.update({ scene_auto: false })],
            ['memory off and on', 'unspecified', t => {
                t.fake.settings.update({ scene_history: false });
                t.fake.settings.update({ scene_history: true });
            }],
            ['wrapper events gone', 'unspecified', t => delete t.fake.context.eventTypes.GROUP_WRAPPER_STARTED],
            ['marked remote by hand', 'remote', t => assert.equal(t.scene.setState('bob.png', 'remote').ok, true)],
            ['line deleted', 'unspecified', t => {
                t.fake.context.chat.splice(1, 1);
                return t.fake.emit('MESSAGE_DELETED', 1);
            }],
        ];
        for (const [label, status, change] of cases) {
            const t = await auto();
            await openScene(t, hello(t.fake), { absent: [] });
            const chat = () => t.fake.context.chat;
            await started(t.fake);
            const left = chat()[await t.fake.receive('alice.png', 'Bob heads out.')];
            const later = chat()[await t.fake.receive('carol.png', 'Quiet now.')];
            assert.deepEqual(note(later), noted('bob.png'), label);

            await change(t);
            await finished(t.fake);
            assert.equal(statusOf(t, 'bob.png'), status, label);
            if (chat().includes(left)) assert.equal(note(left), undefined, label);
            assert.equal(note(later), undefined, label);
            assert.equal(entryNote(later, 0), undefined, label);
            assert.equal(t.recorder.filter(promptOf(chat()), 'normal', 'bob.png'), 0, label);
            assert.deepEqual(t.recorder.getChanges(), [], label);
            assert.deepEqual(t.fake.shownToasts(), [], label);
            assert.equal(t.fake.saves.length, 1, label);
        }
    });

    test('shows lines again only to a member whom a dropped departure alone made absent', async () => {
        // Bob is away; in one round he comes back, leaves again, and a later line is noted against both.
        const roundWithReturn = async () => {
            const t = await auto();
            await openScene(t, hello(t.fake), { absent: ['bob.png'] });
            const chat = () => t.fake.context.chat;
            await started(t.fake);
            await t.fake.receive('alice.png', 'Bob comes back.');
            const left = await t.fake.receive('carol.png', 'Bob heads out.');
            const later = chat()[await t.fake.receive('alice.png', 'Quiet now.')];
            assert.deepEqual(note(later), noted('bob.png'));
            return { t, left, later };
        };

        // Only the departure goes: Bob is back, so the later line no longer hides from him.
        const back = await roundWithReturn();
        back.t.fake.context.chat.splice(back.left, 1);
        await back.t.fake.emit('MESSAGE_DELETED', back.left);
        await finished(back.t.fake);
        assert.equal(statusOf(back.t, 'bob.png'), 'present');
        assert.equal(note(back.later), undefined);

        // Both go: Bob never came back, so the later line still hides from him.
        const away = await roundWithReturn();
        away.t.fake.settings.update({ scene_auto: false });
        await finished(away.t.fake);
        assert.equal(statusOf(away.t, 'bob.png'), 'absent');
        assert.deepEqual(note(away.later), noted('bob.png'));
    });

    test('takes a departure that waited for an Ask out of the notes, and saves at once', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = () => t.fake.context.chat;
        const waitForAsk = async () => {
            const release = t.recorder.hold();
            await started(t.fake);
            const left = await t.fake.receive('alice.png', 'Bob heads out.');
            const later = chat()[await t.fake.receive('carol.png', 'Quiet now.')];
            await finished(t.fake);
            assert.deepEqual(note(later), noted('bob.png'));
            return { release, left, later };
        };

        // The line goes before the Ask settles.
        const first = await waitForAsk();
        chat().splice(first.left, 1);
        await t.fake.emit('MESSAGE_DELETED', first.left);
        assert.equal(t.fake.saves.length, 0);
        first.release();
        assert.equal(note(first.later), undefined);
        assert.equal(t.fake.saves.length, 1);

        // Automatic presence is switched off before the Ask settles.
        const second = await waitForAsk();
        t.fake.settings.update({ scene_auto: false });
        assert.equal(note(second.later), undefined);
        assert.equal(note(chat()[second.left]), undefined);
        assert.equal(t.fake.saves.length, 2);
        second.release();
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.deepEqual(t.fake.shownToasts(), []);
    });

    test('keeps a round\'s changes for its end when scene memory turns on during it', async () => {
        for (const key of ['scene_history', 'scene_controls']) {
            const t = await auto({ settings: { [key]: false } });
            await openScene(t, hello(t.fake), { absent: [] });
            await started(t.fake);
            t.fake.settings.update({ [key]: true });
            await t.fake.receive('carol.png', 'Bob heads out.');
            assert.equal(statusOf(t, 'bob.png'), 'unspecified', key);
            assert.deepEqual(t.fake.shownToasts(), [], key);
            await finished(t.fake);
            assert.equal(statusOf(t, 'bob.png'), 'absent', key);
            assert.deepEqual(t.fake.shownToasts(), [applied], key);
        }
    });

    test('tells its views each time the changes list moves without a scene write', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const shown = [];
        t.recorder.subscribe(() => shown.push(JSON.stringify(t.recorder.getChanges())));
        const upToDate = step => assert.equal(shown.at(-1), JSON.stringify(t.recorder.getChanges()), step);

        await started(t.fake);
        await t.fake.receive('alice.png', 'Bob heads out.');
        upToDate('queued');
        await finished(t.fake);
        upToDate('drained');

        await started(t.fake);
        await t.fake.receive('alice.png', 'Carol heads out.');
        t.fake.settings.update({ scene_auto: false });
        upToDate('switched off');
        t.fake.settings.update({ scene_auto: true });
        await t.fake.receive('alice.png', 'Bob comes back.');
        upToDate('queued again');
        await t.fake.openChat(hello(t.fake));
        upToDate('chat changed');
    });

    test('leaves planned changes to the user\'s line, not a narrator line sent before it', async () => {
        const t = await auto();
        await openScene(t, lines3(t.fake), { absent: ['alice.png'] });
        t.recorder.prepareTurn({ text: 'Alice walks in.', key: keyOf(t) });
        assert.equal(statusOf(t, 'alice.png'), 'present');
        const sys = await push(t.fake, t.fake.message({ mes: 'The lights flicker.', type: 'narrator' }), 'MESSAGE_SENT');
        assert.equal(note(t.fake.context.chat[sys]), undefined);

        // The bias-only send that followed wrote no line, so the planned arrival is taken back.
        await started(t.fake);
        await finished(t.fake);
        assert.equal(statusOf(t, 'alice.png'), 'absent');
    });
});

describe('scene recorder take-backs and Undo', () => {
    const auto = (options = {}) => setup({ ...options, settings: { scene_auto: true, ...options.settings } });
    const hello = fake => [fake.message({ is_user: true, mes: 'Hello?', send_date: iso(START - 1000) })];
    const undone = { level: 'info', text: SCENE_TEXT.P19 };
    const refused = { level: 'warning', text: SCENE_TEXT.P20 };
    const nobody = { 'alice.png': 'unspecified', 'bob.png': 'unspecified', 'carol.png': 'unspecified' };

    /** The Undo a toast offers. */
    function actionOf(toast) {
        assert.equal(toast?.actionLabel, SCENE_TEXT.P12);
        assert.equal(typeof toast.onAction, 'function');
        return toast.onAction;
    }

    /** Alice's reply moves Bob out at once (no round runs), and the user's next line is noted against it. */
    async function departed(t) {
        const chat = t.fake.context.chat;
        const left = chat[await t.fake.receive('alice.png', 'Bob heads out.')];
        const after = chat[await t.fake.sendUser('Psst.')];
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        assert.deepEqual(note(after), noted('bob.png'));
        return { left, after };
    }

    test('withdraws a departure when its line is deleted', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const { left, after } = await departed(t);
        const saved = t.fake.saves.length;
        await t.fake.deleteLine(t.fake.context.chat.indexOf(left));
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(note(after), undefined);
        assert.equal(entryNote(after, 0), undefined);
        assert.equal(t.recorder.filter(promptOf(t.fake.context.chat), 'normal', 'bob.png'), 0);
        assert.deepEqual(t.recorder.getChanges(), []);
        // Delete mode saves before the event, so GCO saves the un-hidden line itself, inside the delete window.
        assert.deepEqual(t.fake.saves.slice(saved).map(save => save.options), [{ allowShrink: true }]);
        assert.equal(t.fake.toasts.length, 1);
    });

    test('withdraws a regenerated departure, so the new replies are not hidden', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        await started(t.fake);
        await t.fake.receive('alice.png', 'Bob heads out.');
        const quiet = chat[await t.fake.receive('carol.png', 'Quiet now.')];
        await finished(t.fake);
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        assert.deepEqual(note(quiet), noted('bob.png'));

        // Group Regenerate deletes the round's replies from the end, then a new round answers.
        while (chat.length > 1) {
            chat.pop();
            await t.fake.emit('MESSAGE_DELETED', chat.length);
        }
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        await started(t.fake);
        const again = chat[await t.fake.receive('carol.png', 'Still quiet.')];
        await finished(t.fake);
        assert.equal(note(again), undefined);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(t.recorder.filter(promptOf(chat), 'normal', 'bob.png'), 0);
    });

    test('withdraws a departure when its version is swiped away', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        const id = await t.fake.receive('alice.png', 'Bob heads out.', 'normal', { alternatives: ['Hm.'] });
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        await t.fake.swipeTo(id, 1);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(note(chat[id]), undefined);

        // A swipe that generates takes the change back before the new version is written.
        const next = await t.fake.receive('carol.png', 'Bob heads out.');
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        await t.fake.swipeGenerate(next);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        await started(t.fake, 'swipe');
        await t.fake.finishSwipe(next, 'Evening.');
        await finished(t.fake, 'swipe');
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(note(chat[next]), undefined);

        // The picker on an older line takes the change back and never applies the version it shows.
        const older = await t.fake.receive('alice.png', 'Bob heads out.', 'normal', { alternatives: ['Hm.'] });
        const evening = chat[await t.fake.receive('carol.png', 'Evening.')];
        assert.deepEqual(note(evening), noted('bob.png'));
        await t.fake.swipeTo(older, 1);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(note(evening), undefined);
        await t.fake.swipeTo(older, 0);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(t.fake.toasts.length, 3);
    });

    test('withdraws a departure when an edit takes it out of the line', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const { left, after } = await departed(t);
        const saved = t.fake.saves.length;
        await t.fake.editLine(t.fake.context.chat.indexOf(left), 'Bob waves.');
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(note(left), undefined);
        assert.equal(entryNote(left, 0), undefined);
        assert.equal(note(after), undefined);
        // The host saves right after an edit.
        assert.equal(t.fake.saves.length, saved);
    });

    test('an edit to an older departure that a later line superseded changes nothing', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        const left = await t.fake.receive('alice.png', 'Bob heads out.');
        const back = await t.fake.receive('carol.png', 'Bob comes back.');
        assert.equal(statusOf(t, 'bob.png'), 'present');
        await t.fake.editLine(left, 'Alice waves.');
        assert.equal(note(chat[left]), undefined);
        assert.equal(statusOf(t, 'bob.png'), 'present');
        assert.deepEqual(note(chat[back]), { v: 1, moved: [['bob.png', 'absent', 'present']] });
        assert.deepEqual(t.recorder.getChanges().map(({ avatar, to, index }) => [avatar, to, index]),
            [['bob.png', 'present', back]]);
        assert.equal(t.fake.toasts.length, 2);
    });

    test('an edit adds a change on the newest line only', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        const older = await t.fake.receive('alice.png', 'Evening.');
        const newest = await t.fake.receive('carol.png', 'Hm.');
        await t.fake.editLine(older, 'Bob heads out.');
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(note(chat[older]), undefined);
        await t.fake.editLine(newest, 'Bob heads out.');
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        assert.deepEqual(note(chat[newest]), { v: 1, moved: [['bob.png', 'unspecified', 'absent']] });
        assert.deepEqual(t.fake.shownToasts(), [applied]);
    });

    test('an edit reads the newest line against the scene after its own take-back', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        const id = await t.fake.receive('alice.png', 'Bob heads out.');
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        // Bob was never away before this line, so once its departure is gone, coming back moves nobody.
        await t.fake.editLine(id, 'Bob comes back.');
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(note(chat[id]), undefined);
        assert.equal(t.fake.toasts.length, 1);
    });

    test('an edit that takes out an arrival puts its member back on the away list', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake));
        const chat = t.fake.context.chat;
        const id = await t.fake.receive('alice.png', 'Bob comes back.');
        assert.equal(statusOf(t, 'bob.png'), 'present');
        assert.deepEqual(note(chat[id]), { v: 1, moved: [['bob.png', 'absent', 'present']] });
        await t.fake.editLine(id, 'Evening.');
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        assert.deepEqual(note(chat[id]), noted('bob.png'));
        assert.deepEqual(entryNote(chat[id], 0), noted('bob.png'));
        assert.equal(t.recorder.filter(promptOf(chat), 'normal', 'bob.png'), 1);
    });

    test('a manual change blocks withdrawal', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        const { left, after } = await departed(t);
        // Marked present and away again by hand: the user's choice stands when the line goes.
        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        await t.fake.deleteLine(chat.indexOf(left));
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        assert.deepEqual(note(after), noted('bob.png'));

        // The next automatic change for Bob clears the mark.
        await t.fake.receive('carol.png', 'Bob comes back.');
        const again = chat[await t.fake.receive('alice.png', 'Bob heads out.')];
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        await t.fake.deleteLine(chat.indexOf(again));
        assert.equal(statusOf(t, 'bob.png'), 'present');
    });

    test('a manual change made right after turn-on still counts as manual', async () => {
        const t = await auto();
        t.fake.settings.update({ scene_history: false });
        await openScene(t, hello(t.fake), { absent: [] });
        t.fake.settings.update({ scene_history: true });
        const chat = t.fake.context.chat;
        const { left } = await departed(t);
        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        await t.fake.deleteLine(chat.indexOf(left));
        assert.equal(statusOf(t, 'bob.png'), 'absent');
    });

    test('a manual change still blocks withdrawal after another chat was opened', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        const { left, after } = await departed(t);
        assert.equal(t.scene.setState('bob.png', 'present').ok, true);
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        switchChat(t.fake, 'c2');
        await t.fake.openChat(hello(t.fake));
        switchChat(t.fake, 'c1');
        await t.fake.openChat(chat);
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        await t.fake.deleteLine(chat.indexOf(left));
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        assert.deepEqual(note(after), noted('bob.png'));
    });

    test('Undo restores the status, reveals the lines and is not re-applied by Continue or a typo edit', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        const { left, after } = await departed(t);
        const saved = t.fake.saves.length;
        const [change] = t.recorder.getChanges();
        assert.deepEqual(t.recorder.undo(change.id), { ok: true, reason: '' });
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.deepEqual(note(left), { v: 1, undone: ['bob.png'] });
        assert.deepEqual(entryNote(left, 0), { v: 1, undone: ['bob.png'] });
        assert.equal(note(after), undefined);
        assert.equal(t.recorder.filter(promptOf(chat), 'normal', 'bob.png'), 0);
        assert.deepEqual(t.recorder.getChanges(), []);
        assert.deepEqual(t.fake.shownToasts().slice(1), [undone]);
        assert.equal(t.fake.saves.length, saved + 1);
        // Pressed twice, the second Undo finds nothing to take back.
        assert.deepEqual(t.recorder.undo(change.id), { ok: false, reason: 'gone' });
        assert.deepEqual(t.fake.shownToasts().slice(1), [undone, refused]);

        // Undo from the toast; then Continue and a typo edit on that line never bring the change back.
        const id = await t.fake.receive('carol.png', 'Bob heads out.');
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        actionOf(t.fake.toasts.at(-1))();
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        await t.fake.continueLine(id, ' Then Bob heads out.');
        await t.fake.editLine(id, 'Bob heads out! Then Bob heads out.');
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.deepEqual(note(chat[id]), { v: 1, undone: ['bob.png'] });
        assert.deepEqual(t.fake.shownToasts().slice(4), [undone]);
    });

    test('Undo on a round\'s toast takes back every change it applied', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        await started(t.fake);
        await t.fake.receive('alice.png', 'Bob heads out.');
        const second = chat[await t.fake.receive('alice.png', 'Carol heads out.')];
        await finished(t.fake);
        assert.deepEqual(statusesOf(t), { ...nobody, 'bob.png': 'absent', 'carol.png': 'absent' });
        assert.deepEqual(note(second), { v: 1, away: ['bob.png'], moved: [['carol.png', 'unspecified', 'absent']] });
        assert.equal(t.fake.toasts.length, 1);
        actionOf(t.fake.toasts[0])();
        assert.deepEqual(statusesOf(t), nobody);
        assert.deepEqual(note(second), { v: 1, undone: ['carol.png'] });
        assert.deepEqual(t.fake.shownToasts().slice(1), [undone]);
        assert.deepEqual(t.recorder.getChanges(), []);
    });

    test('takes back an Undo pressed during a round at the round\'s end', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const { left, after } = await departed(t);
        const saved = t.fake.saves.length;
        t.fake.setGenerating(true);
        await started(t.fake);
        const [change] = t.recorder.getChanges();
        assert.deepEqual(t.recorder.undo(change.id), { ok: true, reason: '' });
        // The notes change at once; the scene waits for the round.
        assert.deepEqual(note(left), { v: 1, undone: ['bob.png'] });
        assert.equal(note(after), undefined);
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        // A line noted meanwhile already counts Bob as back.
        const reply = t.fake.context.chat[await t.fake.receive('carol.png', 'Evening.')];
        assert.equal(note(reply), undefined);
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        // The host's reply save carried the notes.
        assert.equal(t.fake.saves.length, saved);
    });

    test('Undo takes back a change still waiting for the round', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        t.fake.setGenerating(true);
        await started(t.fake);
        const id = await t.fake.receive('alice.png', 'Bob heads out.');
        const quiet = chat[await t.fake.receive('carol.png', 'Quiet now.')];
        assert.deepEqual(note(quiet), noted('bob.png'));
        const [change] = t.recorder.getChanges();
        assert.equal(change.pending, true);
        assert.deepEqual(t.recorder.undo(change.id), { ok: true, reason: '' });
        assert.deepEqual(note(chat[id]), { v: 1, undone: ['bob.png'] });
        assert.deepEqual(entryNote(chat[id], 0), { v: 1, undone: ['bob.png'] });
        assert.equal(note(quiet), undefined);
        assert.deepEqual(t.fake.shownToasts(), [undone]);
        assert.deepEqual(t.recorder.getChanges(), []);
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');

        // The Undo stays on the line: continuing it never moves Bob again.
        await t.fake.continueLine(id, ' Bob heads out.');
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.deepEqual(note(chat[id]), { v: 1, undone: ['bob.png'] });
        assert.deepEqual(t.fake.shownToasts(), [undone]);
    });

    test('a take-back during a round puts the member back before the changes that wait for it', async () => {
        const ways = [
            ['Undo', t => assert.deepEqual(t.recorder.undo(t.recorder.getChanges().find(row => !row.pending).id),
                { ok: true, reason: '' })],
            ['delete', (t, left) => t.fake.deleteLine(t.fake.context.chat.indexOf(left))],
        ];
        for (const [label, takeBack] of ways) {
            const t = await auto();
            await openScene(t, hello(t.fake), { absent: [] });
            const chat = t.fake.context.chat;
            const left = chat[await t.fake.receive('alice.png', 'Bob heads out.')];
            assert.equal(statusOf(t, 'bob.png'), 'absent', label);
            t.fake.setGenerating(true);
            await started(t.fake);
            const back = chat[await t.fake.receive('carol.png', 'Bob comes back.')];
            assert.deepEqual(note(back), { v: 1, moved: [['bob.png', 'absent', 'present']] }, label);
            await takeBack(t, left);
            t.fake.setGenerating(false);
            await finished(t.fake);
            // Bob never left, so his return moves nobody and leaves the note.
            assert.equal(statusOf(t, 'bob.png'), 'unspecified', label);
            assert.equal(note(back), undefined, label);
            assert.deepEqual(t.recorder.getChanges(), [], label);
        }
    });

    test('undoes a routed plan\'s change before or after its line is sent', async () => {
        for (const sentFirst of [false, true]) {
            const label = sentFirst ? 'after the send' : 'before the send';
            const t = await auto();
            await openScene(t, lines3(t.fake), { absent: ['alice.png'] });
            t.recorder.prepareTurn({ text: 'Alice walks in.', key: keyOf(t) });
            assert.equal(statusOf(t, 'alice.png'), 'present', label);
            const undo = actionOf(t.fake.toasts[0]);
            t.fake.setGenerating(true);
            let id;
            if (sentFirst) id = await t.fake.sendUser('Alice walks in. Hi Alice');
            undo();
            if (!sentFirst) id = await t.fake.sendUser('Alice walks in. Hi Alice');
            // The scene waits for the round, and the user's line never moves Alice.
            assert.equal(statusOf(t, 'alice.png'), 'present', label);
            assert.deepEqual(note(t.fake.context.chat[id]),
                sentFirst ? { v: 1, undone: ['alice.png'] } : { v: 1, away: ['alice.png'], undone: ['alice.png'] }, label);
            await started(t.fake);
            await t.fake.receive('carol.png', 'Evening.');
            t.fake.setGenerating(false);
            await finished(t.fake);
            assert.equal(statusOf(t, 'alice.png'), 'absent', label);
            assert.deepEqual(t.fake.shownToasts().slice(1), [undone], label);
            assert.deepEqual(t.recorder.getChanges(), [], label);
        }
    });

    test('reports what Undo can no longer take back', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const chat = t.fake.context.chat;
        const left = chat[await t.fake.receive('alice.png', 'Bob heads out.')];
        const [departure] = t.recorder.getChanges();
        await t.fake.receive('carol.png', 'Bob comes back.');
        const [arrival] = t.recorder.getChanges();
        assert.deepEqual(t.recorder.undo(departure.id), { ok: false, reason: 'superseded' });
        for (const id of [undefined, 42, 'not json', '[1,0,"bob.png"]', JSON.stringify([999, 0, 'bob.png', 'absent'])]) {
            assert.deepEqual(t.recorder.undo(id), { ok: false, reason: 'gone' }, String(id));
        }
        await t.fake.deleteLine(chat.indexOf(left));
        assert.deepEqual(t.recorder.undo(departure.id), { ok: false, reason: 'gone' });
        assert.equal(statusOf(t, 'bob.png'), 'present');
        t.fake.settings.update({ scene_history: false });
        assert.deepEqual(t.recorder.undo(arrival.id), { ok: false, reason: 'off' });
        assert.equal(statusOf(t, 'bob.png'), 'present');
        assert.deepEqual(t.fake.shownToasts().slice(2), Array(8).fill(refused));
    });

    test('swiping back to a read version re-applies its stored change where the live status allows', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: [] });
        const id = await t.fake.receive('alice.png', 'Bob heads out.', 'normal', { alternatives: ['Hm.'] });
        await t.fake.swipeTo(id, 1);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        await t.fake.swipeTo(id, 0);
        assert.equal(statusOf(t, 'bob.png'), 'absent');
        assert.equal(t.fake.toasts.length, 2);
        actionOf(t.fake.toasts[1]);

        // Marked remote by hand meanwhile: the stored departure no longer applies.
        await t.fake.swipeTo(id, 1);
        assert.equal(statusOf(t, 'bob.png'), 'unspecified');
        assert.equal(t.scene.setState('bob.png', 'remote').ok, true);
        await t.fake.swipeTo(id, 0);
        assert.equal(statusOf(t, 'bob.png'), 'remote');
        assert.equal(t.fake.toasts.length, 2);
    });

    test('Continue can only shrink away and never re-adds an undone change', async () => {
        const t = await auto();
        await openScene(t, hello(t.fake), { absent: ['carol.png'] });
        const chat = t.fake.context.chat;
        const id = await t.fake.receive('alice.png', 'Carol walks in.');
        assert.equal(statusOf(t, 'carol.png'), 'present');
        actionOf(t.fake.toasts[0])();
        assert.equal(statusOf(t, 'carol.png'), 'absent');
        assert.deepEqual(note(chat[id]), { v: 1, undone: ['carol.png'] });

        // Bob is marked away before the line continues: its note never gains him.
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        await t.fake.continueLine(id, ' Carol walks in again.');
        assert.deepEqual(note(chat[id]), { v: 1, undone: ['carol.png'] });
        assert.equal(statusOf(t, 'carol.png'), 'absent');
        assert.deepEqual(t.fake.shownToasts().slice(1), [undone]);
    });

    test('seeds a branch\'s scene from its newest recorded line, with Undo', async () => {
        const t = await setup();
        const branch = () => [
            t.fake.message({ avatar: 'alice.png', mes: 'One.', send_date: iso(START - 3000) }),
            t.fake.message({ avatar: 'bob.png', mes: 'Two.', send_date: iso(START - 2000),
                extra: { sbu_scene: { v: 1, away: ['carol.png'], moved: [['alice.png', 'present', 'absent']] } } }),
            t.fake.message({ avatar: 'carol.png', mes: 'Hidden.', send_date: iso(START - 1000), is_system: true }),
        ];
        switchChat(t.fake, 'branch');
        await t.fake.openChat(branch());
        assert.deepEqual(statusesOf(t), { ...nobody, 'alice.png': 'absent', 'carol.png': 'absent' });
        assert.deepEqual(t.fake.shownToasts(), [withUndo({ level: 'info', text: SCENE_TEXT.P13 })]);
        assert.deepEqual(t.fake.saves, []);
        actionOf(t.fake.toasts[0])();
        assert.deepEqual(statusesOf(t), nobody);
        assert.deepEqual(t.fake.shownToasts().slice(1), [undone]);

        // The chat now has its own scene, so opening it again seeds nothing.
        await t.fake.openChat(branch());
        assert.deepEqual(statusesOf(t), nobody);

        // Nothing is seeded while scene memory is off, or from a newest line without a note.
        t.fake.settings.update({ scene_history: false });
        switchChat(t.fake, 'while off');
        await t.fake.openChat(branch());
        t.fake.settings.update({ scene_history: true });
        assert.deepEqual(statusesOf(t), nobody);
        switchChat(t.fake, 'plain');
        await t.fake.openChat([...branch(), t.fake.message({ avatar: 'alice.png', mes: 'Three.' })]);
        assert.deepEqual(statusesOf(t), nobody);
        assert.equal(t.fake.toasts.length, 2);
    });

    test('rebuilds the index after a simulated reload', async () => {
        const first = await auto();
        await openScene(first, hello(first.fake), { absent: [] });
        const chat = first.fake.context.chat;
        await started(first.fake);
        const left = chat[await first.fake.receive('alice.png', 'Bob heads out.')];
        const quiet = chat[await first.fake.receive('carol.png', 'Quiet now.')];
        await finished(first.fake);
        first.recorder.destroy();

        // A page reload: a new recorder over the same chat and scene, with nothing of the round in memory.
        const second = attach(first.fake);
        assert.deepEqual(second.recorder.getChanges().map(({ avatar, to, index }) => [avatar, to, index]),
            [['bob.png', 'absent', 1]]);
        await first.fake.deleteLine(chat.indexOf(left));
        assert.equal(statusOf(second, 'bob.png'), 'unspecified');
        assert.equal(note(quiet), undefined);
    });

    test('join Undo shows every earlier line and survives a refused save as a reveal pair', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [], metadata: header([]) });
        const chat = () => t.fake.context.chat;
        const key = keyOf(t);
        await t.fake.addMember('dave.png');
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, [['dave.png', iso(START - 1000)]]);
        assert.deepEqual(t.fake.shownToasts(), [withUndo({ level: 'info', text: SCENE_TEXT.P25, detail: 'Dave (3)' })]);
        assert.equal(t.recorder.filter(promptOf(chat()), 'normal', 'dave.png'), 3);
        const saved = t.fake.saves.length;

        t.fake.context.saveResult = false;
        actionOf(t.fake.toasts[0])();
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, []);
        assert.deepEqual(t.fake.shownToasts().slice(1), [{ level: 'info', text: SCENE_TEXT.P24 }]);
        assert.equal(t.fake.saves.length, saved + 1);
        assert.equal(t.recorder.filter(promptOf(chat()), 'normal', 'dave.png'), 0);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(t.fake.settings.get().scene_join_reveals, [[key, 'dave.png']]);

        // The file still holds the join: opening the chat again takes it out again.
        await t.fake.openChat(lines3(t.fake), header([['dave.png', iso(START - 1000)]]));
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, []);
        assert.equal(t.recorder.filter(promptOf(chat()), 'normal', 'dave.png'), 0);
        assert.equal(t.recorder.joinStatus('dave.png').joinedAt, null);
        assert.equal(t.fake.toasts.length, 2);

        // The first save that carries the removal drops the pair.
        t.fake.context.saveResult = true;
        assert.equal(t.scene.setState('bob.png', 'absent').ok, true);
        await t.fake.sendUser('Hi.');
        assert.equal(t.fake.settings.get().scene_join_reveals, null);
    });

    test('gives the last line before a join even when another rule keeps or hides it', async () => {
        const cases = [
            ['written as Dave', fake => fake.message({ avatar: 'dave.png', mes: 'Written as Dave.',
                send_date: iso(START - 1000) })],
            ['already away', fake => fake.message({ avatar: 'bob.png', mes: 'Hey.', send_date: iso(START - 1000),
                extra: away('dave.png') })],
        ];
        for (const [label, last] of cases) {
            const t = await setup();
            const lines = lines3(t.fake);
            lines[2] = last(t.fake);
            await openScene(t, lines, { absent: [], metadata: header([]) });
            await t.fake.addMember('dave.png');
            assert.deepEqual(t.recorder.joinStatus('dave.png'),
                { joinedAt: START - 1000, lastPreJoin: 2, hidden: 2, off: null }, label);
        }
    });

    test('reports a joiner\'s status, and when knows everything or Vocalia turns join hiding off', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [], metadata: header([]) });
        const none = { joinedAt: null, lastPreJoin: null, hidden: 0, off: null };
        assert.deepEqual(t.recorder.joinStatus('dave.png'), none);
        await t.fake.addMember('dave.png');
        const joined = { joinedAt: START - 1000, lastPreJoin: 2, hidden: 3, off: null };
        assert.deepEqual(t.recorder.joinStatus('dave.png'), joined);
        assert.deepEqual(t.recorder.joinStatus('alice.png'), none);
        await t.fake.receive('alice.png', 'After the join.');
        assert.deepEqual(t.recorder.joinStatus('dave.png'), joined);

        t.recorder.setOmniscient('dave.png', true);
        assert.deepEqual(t.recorder.joinStatus('dave.png'), { ...joined, off: 'omniscient' });
        t.recorder.setOmniscient('dave.png', false);
        t.fake.context.extensionSettings.aspect_vocalia = { enabled: true };
        assert.deepEqual(t.recorder.joinStatus('dave.png'), { ...joined, off: 'vocalia' });
        delete t.fake.context.extensionSettings.aspect_vocalia;
        t.fake.settings.update({ scene_history: false });
        assert.deepEqual(t.recorder.joinStatus('dave.png'), none);
        for (const avatar of [undefined, null, '', 42]) assert.deepEqual(t.recorder.joinStatus(avatar), none, String(avatar));
    });

    test('the join toast names each newcomer with the earlier lines hidden from them, and its Undo forgets them all',
        async () => {
            const t = await setup();
            await openScene(t, lines3(t.fake), { absent: [], metadata: header([]) });
            await t.fake.addMember('dave.png', { event: false });
            await t.fake.addMember('erin.png');
            assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined,
                [['dave.png', iso(START - 1000)], ['erin.png', iso(START - 1000)]]);
            assert.deepEqual(t.fake.shownToasts(),
                [withUndo({ level: 'info', text: SCENE_TEXT.P25, detail: 'Dave (3), Erin (3)' })]);
            actionOf(t.fake.toasts[0])();
            assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, []);
        });

    test('the join toast counts nothing hidden for a newcomer who knows everything', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [], metadata: header([]) });
        t.recorder.setOmniscient('dave.png', true);
        await t.fake.addMember('dave.png');
        assert.deepEqual(t.fake.shownToasts(), [withUndo({ level: 'info', text: SCENE_TEXT.P25, detail: 'Dave (0)' })]);
    });

    test('a reveal from the panel reports in the panel only', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [], metadata: header([]) });
        await t.fake.addMember('dave.png');
        const shown = t.fake.toasts.length;
        assert.deepEqual(t.recorder.forgetJoin('dave.png', undefined, { toast: false }), { ok: true, applied: true });
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, []);
        assert.equal(t.fake.toasts.length, shown);
        assert.deepEqual(t.recorder.forgetJoin('dave.png', null, { toast: false }), { ok: false, applied: false });
        assert.equal(t.fake.toasts.length, shown);
    });

    test('forgets a join on request and saves it like a live join', async () => {
        const t = await setup();
        await openScene(t, lines3(t.fake), { absent: [], metadata: header([]) });
        await t.fake.addMember('dave.png');
        let saved = t.fake.saves.length;
        let notified = 0;
        t.recorder.subscribe(() => notified++);
        assert.deepEqual(t.recorder.forgetJoin('dave.png'), { ok: true, applied: true });
        assert.deepEqual(t.fake.context.chatMetadata[ROSTER_KEY].joined, []);
        assert.equal(t.fake.saves.length, saved + 1);
        assert.deepEqual(t.fake.shownToasts().at(-1), { level: 'info', text: SCENE_TEXT.P24 });
        assert.equal(t.recorder.joinStatus('dave.png').joinedAt, null);
        assert.ok(notified > 0);

        // While the host generates, the round's end saves it.
        await t.fake.addMember('erin.png');
        saved = t.fake.saves.length;
        t.fake.setGenerating(true);
        await started(t.fake);
        assert.deepEqual(t.recorder.forgetJoin('erin.png'), { ok: true, applied: true });
        assert.equal(t.fake.saves.length, saved);
        t.fake.setGenerating(false);
        await finished(t.fake);
        assert.equal(t.fake.saves.length, saved + 1);
        assert.deepEqual(t.fake.saves.at(-1).metadata[ROSTER_KEY].joined, []);

        // For a chat that is not open, only the reveal pair is kept.
        const other = JSON.stringify(['g1', 'other']);
        assert.deepEqual(t.recorder.forgetJoin('dave.png', other), { ok: true, applied: false });
        assert.deepEqual(t.fake.settings.get().scene_join_reveals, [[other, 'dave.png']]);
        assert.equal(t.fake.saves.length, saved + 1);
        assert.deepEqual(t.fake.shownToasts().at(-1), { level: 'info', text: SCENE_TEXT.P24 });
    });
});

describe('scene recorder cost', () => {
    test('reads no history and no scene while scene memory is off', async () => {
        const fake = await createFakeHost({ settings: { scene_history: false } });
        const scene = createSceneStore(fake);
        let snapshots = 0;
        const counted = { ...scene, getSnapshot: () => { snapshots++; return scene.getSnapshot(); } };
        let versionReads = 0;
        const lines = lines3(fake).map(line => {
            const versions = line.swipes;
            Object.defineProperty(line, 'swipes', { get() { versionReads++; return versions; }, enumerable: true });
            return line;
        });
        createSceneRecorder({ host: fake.host, settings: fake.settings, scene: counted, now: fake.clock.now, log: () => {} });
        await fake.openChat(lines);
        scene.update?.({});
        await fake.emit('CHAT_CHANGED', fake.context.chatId);
        assert.equal(versionReads, 0);
        assert.equal(snapshots, 0);
    });

    test('a joiner costs no more host context reads than a founder, however long the chat', async () => {
        const fake = await createFakeHost({ members: WITH_DAVE });
        // The real getContext() builds a new object of about 180 properties on every call.
        let reads = 0;
        const host = createHostAdapter({ getContext: () => { reads++; return fake.context; }, document: undefined });
        const recorder = createSceneRecorder({ host, settings: fake.settings,
            scene: createSceneStore({ host, settings: fake.settings }), now: fake.clock.now, log: () => {} });
        const first = START - 10_000_000;
        const lines = Array.from({ length: 5000 }, (_, index) => fake.message({
            avatar: FOUNDERS[index % FOUNDERS.length], mes: `Line ${index}.`, send_date: iso(first + index * 1000),
        }));
        await fake.openChat(lines, header([['dave.png', iso(first + 2500 * 1000)]]));
        const readsDuring = run => {
            reads = 0;
            run();
            return reads;
        };

        const founder = readsDuring(() => assert.equal(recorder.filter(promptOf(lines), 'normal', 'alice.png'), 0));
        const joiner = readsDuring(() => assert.equal(recorder.filter(promptOf(lines), 'normal', 'dave.png'), 2501));
        assert.ok(joiner - founder <= 5, `filter: joiner ${joiner}, founder ${founder}`);
        assert.ok(joiner <= 50, `filter: ${joiner} reads for 5,000 lines`);

        const founderPreview = readsDuring(() => assert.equal(recorder.hiddenFor('alice.png').joined, 0));
        const joinerPreview = readsDuring(() => assert.equal(recorder.hiddenFor('dave.png').joined, 2501));
        assert.ok(joinerPreview - founderPreview <= 5, `preview: joiner ${joinerPreview}, founder ${founderPreview}`);
        assert.ok(joinerPreview <= 50, `preview: ${joinerPreview} reads for 5,000 lines`);
    });
});
