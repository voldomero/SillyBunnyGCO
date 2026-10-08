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
const FOUNDERS = ['alice.png', 'bob.png', 'carol.png'];
const WITH_DAVE = [...FOUNDERS, 'dave.png'];
const iso = ms => new Date(ms).toISOString();
const away = (...avatars) => ({ sbu_scene: { v: 1, away: avatars } });
const promptOf = chat => chat.map(message => ({ ...message }));
const header = joined => ({ integrity: 'fake-integrity', [ROSTER_KEY]: { v: 1, group: 'g1', since: TOKEN, floor: null,
    known: [...FOUNDERS, ...joined.map(([avatar]) => avatar)], gone: [], joined } });

async function setup(options = {}) {
    const fake = await createFakeHost(options);
    const logs = [];
    const recorder = createSceneRecorder({ host: fake.host, settings: fake.settings, scene: createSceneStore(fake),
        now: fake.clock.now, log: (...args) => logs.push(args) });
    return { fake, recorder, logs };
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
    test('defines every placeholder once, frozen', () => {
        const keys = ['P1', 'P1h', 'P2', 'P2h', ...Array.from({ length: 26 }, (_, index) => `P${index + 3}`),
            'P6present', 'P6absent', 'P6remote', 'R1'];
        assert.ok(Object.isFrozen(SCENE_TEXT));
        assert.deepEqual(Object.keys(SCENE_TEXT).sort(), [...keys].sort());
        for (const key of keys) assert.equal(SCENE_TEXT[key], 'lorum ipsum', key);
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
});

describe('scene recorder cost', () => {
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
