import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateReplyRules } from '../src/reply-rules.js';
import { createRoutingController } from '../src/routing-controller.js';
import { createSceneRecorder } from '../src/scene-recorder.js';
import { createSceneStore } from '../src/scene-state.js';
import { SCENE_TEXT } from '../src/scene-text.js';
import { createTurnController } from '../src/turn-controller.js';
import { createFakeHost } from './helpers/fake-host.mjs';

const START = Date.UTC(2026, 9, 8, 1, 0, 0);
const iso = ms => new Date(ms).toISOString();
const note = line => line?.extra?.sbu_scene;
const applied = { level: 'info', text: SCENE_TEXT.P11 };
const wrapper = (fake, name, type = 'normal') => fake.emit(name, { selected_group: 'g1', type });
// Request timeouts work as usual, but a failed test does not keep the run open until they fire.
const setTimer = (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
};

/**
 * SillyBunny's routing lease (group-turn-routing.js) for one owner. Each routed message sends turn-started
 * and asks the owner to plan; the host then sends acknowledged, reply-started, reply-completed and finished.
 */
function createLeaseHost(context) {
    let owner = null;
    let turns = 0;
    const cancelled = [];
    context.groupTurnRouting = Object.freeze({
        version: 1,
        acquire(options) {
            if (owner) return null;
            owner = options;
            return Object.freeze({
                isCurrent: () => owner === options,
                release: () => { if (owner === options) owner = null; },
                cancel: reason => cancelled.push(reason),
            });
        },
    });
    return {
        cancelled,
        route(text) {
            const current = owner;
            const ids = { requestId: `group-turn-${++turns}`, turnId: turns };
            const send = (type, details = {}) => current.onEvent({ type, ...ids, ...details });
            send('turn-started');
            const plan = current.plan({ ...ids, groupId: current.groupId, chatId: current.chatId, chat: context.chat, text });
            return {
                plan,
                acknowledge: () => send('acknowledged'),
                startReply(avatar) {
                    if (cancelled.length || !plan?.isCurrent()) return false;
                    send('reply-started', { avatar });
                    return true;
                },
                finishReply: avatar => send('reply-completed', { avatar, status: 'success' }),
                finish: (status = 'success') => send('finished', { status }),
            };
        },
    };
}

async function setup({ settings = {}, absent = [] } = {}) {
    const fake = await createFakeHost({ settings: { scene_auto: true, reply_rules: { enabled: true }, ...settings } });
    const lease = createLeaseHost(fake.context);
    const scene = createSceneStore(fake);
    const recorder = createSceneRecorder({ host: fake.host, settings: fake.settings, scene, now: fake.clock.now, log: () => {} });
    const controller = createTurnController({ host: fake.host, settings: fake.settings, scene, decide: evaluateReplyRules,
        createRoutingController, sceneMemory: recorder, setTimer });
    await fake.openChat([fake.message({ avatar: 'carol.png', mes: 'Evening.', send_date: iso(START - 1000) })]);
    for (const avatar of absent) assert.equal(scene.setState(avatar, 'absent').ok, true, avatar);
    return {
        fake, lease, scene, recorder, controller,
        key: fake.host.activeConversation().key,
        statusOf: avatar => scene.getSnapshot().participants.find(member => member.avatar === avatar)?.status,
    };
}

describe('scene memory around routed turns', () => {
    test('routes "Alice walks in. Hi Alice" to Alice', async () => {
        const t = await setup({ absent: ['alice.png'] });
        assert.equal(t.controller.setAutomaticRouting(true).ok, true);

        const turn = t.lease.route('Alice walks in. Hi Alice');
        assert.deepEqual(turn.plan?.avatars, ['alice.png']);
        assert.equal(t.statusOf('alice.png'), 'present');
        assert.deepEqual(t.fake.toasts, [applied]);

        t.fake.setGenerating(true);
        const id = await t.fake.sendUser('Alice walks in. Hi Alice');
        assert.deepEqual(note(t.fake.context.chat[id]), { v: 1, moved: [['alice.png', 'absent', 'present']] });
        turn.acknowledge();
        assert.equal(turn.plan.isCurrent(), true);

        await wrapper(t.fake, 'GROUP_WRAPPER_STARTED');
        assert.equal(turn.startReply('alice.png'), true);
        await t.fake.receive('alice.png', 'Hello!');
        turn.finishReply('alice.png');
        turn.finish();
        t.fake.setGenerating(false);
        await wrapper(t.fake, 'GROUP_WRAPPER_FINISHED');
        assert.equal(t.statusOf('alice.png'), 'present');
        assert.deepEqual(t.lease.cancelled, []);
        assert.deepEqual(t.fake.toasts, [applied]);
    });

    test('queues a departure in a reply and applies it after the round', async () => {
        const t = await setup({ settings: {
            reply_rules: { enabled: true, multiSpeaker: true, maxParticipants: 2, maxResponses: 2 },
        } });
        assert.equal(t.controller.setAutomaticRouting(true).ok, true);
        const turn = t.lease.route('Bob, Alice, hello.');
        assert.deepEqual(turn.plan?.avatars, ['bob.png', 'alice.png']);
        t.fake.setGenerating(true);
        await t.fake.sendUser('Bob, Alice, hello.');
        turn.acknowledge();
        await wrapper(t.fake, 'GROUP_WRAPPER_STARTED');

        assert.equal(turn.startReply('bob.png'), true);
        const left = await t.fake.receive('bob.png', 'Bob heads out.');
        turn.finishReply('bob.png');
        assert.deepEqual(note(t.fake.context.chat[left]), { v: 1, moved: [['bob.png', 'unspecified', 'absent']] });
        assert.equal(t.statusOf('bob.png'), 'unspecified');
        assert.equal(turn.startReply('alice.png'), true);
        const bye = await t.fake.receive('alice.png', 'Bye then.');
        turn.finishReply('alice.png');
        assert.deepEqual(note(t.fake.context.chat[bye]), { v: 1, away: ['bob.png'] });
        assert.equal(turn.plan.isCurrent(), true);
        turn.finish();
        assert.equal(t.statusOf('bob.png'), 'unspecified');
        assert.deepEqual(t.fake.toasts, []);

        t.fake.setGenerating(false);
        await wrapper(t.fake, 'GROUP_WRAPPER_FINISHED');
        assert.equal(t.statusOf('bob.png'), 'absent');
        assert.deepEqual(t.fake.toasts, [applied]);
        assert.deepEqual(t.lease.cancelled, []);
    });

    test('keeps an Ask current when the asked member leaves in its reply', async () => {
        const t = await setup();
        const duringAsk = [];
        t.fake.context.generate = async () => {
            t.fake.setGenerating(true);
            await wrapper(t.fake, 'GROUP_WRAPPER_STARTED');
            await t.fake.receive('bob.png', 'I head out.');
            t.fake.setGenerating(false);
            await wrapper(t.fake, 'GROUP_WRAPPER_FINISHED');
            duringAsk.push(t.statusOf('bob.png'));
        };

        const result = await t.controller.askToRespond('bob.png', t.key);
        assert.equal(result.status, 'returned');
        assert.deepEqual(duringAsk, ['unspecified']);
        assert.equal(t.statusOf('bob.png'), 'absent');
        assert.deepEqual(t.fake.toasts, [applied]);
    });

    test('declines a plan whose staged member just left', async () => {
        const t = await setup();
        assert.equal(t.controller.stageResponder('bob.png', t.key).ok, true);

        const turn = t.lease.route('Bob leaves.');
        assert.equal(turn.plan, null);
        assert.equal(t.statusOf('bob.png'), 'absent');
        assert.equal(t.lease.cancelled.length, 1);
        assert.deepEqual(t.controller.getRoutingState().staged, []);

        // Native routing answers instead, and the sent line carries the change the plan made.
        turn.finish('declined');
        t.fake.setGenerating(true);
        const id = await t.fake.sendUser('Bob leaves.');
        assert.deepEqual(note(t.fake.context.chat[id]), { v: 1, moved: [['bob.png', 'unspecified', 'absent']] });
        t.fake.setGenerating(false);
        await wrapper(t.fake, 'GROUP_WRAPPER_FINISHED');
        assert.equal(t.statusOf('bob.png'), 'absent');
        assert.deepEqual(t.fake.toasts, [applied]);
    });

    test('clears the staged pick when its member\'s departure applies at the round end', async () => {
        const t = await setup();
        assert.equal(t.controller.stageResponder('bob.png', t.key).ok, true);

        // A round GCO did not plan, such as a regenerate or /trigger.
        t.fake.setGenerating(true);
        await wrapper(t.fake, 'GROUP_WRAPPER_STARTED');
        await t.fake.receive('alice.png', 'Bob heads out.');
        assert.deepEqual(t.controller.getRoutingState().staged, ['bob.png']);
        t.fake.setGenerating(false);
        await wrapper(t.fake, 'GROUP_WRAPPER_FINISHED');
        assert.equal(t.statusOf('bob.png'), 'absent');
        assert.deepEqual(t.controller.getRoutingState().staged, []);
    });

    test('checks the request again after prepare, even when nothing announces its change', async () => {
        const fake = await createFakeHost({ settings: { reply_rules: { enabled: true } } });
        const lease = createLeaseHost(fake.context);
        const scene = createSceneStore(fake);
        let decisions = 0;
        const decide = input => {
            decisions++;
            return evaluateReplyRules(input);
        };
        // Muting a member emits no event and writes no setting.
        const sceneMemory = { prepareTurn: () => fake.group.disabled_members.push('bob.png'), hold: () => () => {} };
        const controller = createTurnController({ host: fake.host, settings: fake.settings, scene, decide,
            createRoutingController, sceneMemory, setTimer });
        await fake.openChat([fake.message({ avatar: 'carol.png', mes: 'Evening.', send_date: iso(START - 1000) })]);
        assert.equal(controller.stageResponder('bob.png', fake.host.activeConversation().key).ok, true);

        const turn = lease.route('Hello.');
        assert.equal(turn.plan, null);
        assert.equal(lease.cancelled.length, 1);
        assert.equal(decisions, 0);
        assert.deepEqual(controller.getRoutingState().staged, []);
    });
});
