import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHostAdapter } from '../src/host-adapter.js';
import { evaluateReplyRules } from '../src/reply-rules.js';
import { createRoutingController } from '../src/routing-controller.js';
import { createSceneStore } from '../src/scene-state.js';
import { createTurnController } from '../src/turn-controller.js';

const conversationKey = JSON.stringify(['group-1', 'chat-1']);

function createEventSource() {
    const listeners = new Map();
    return {
        on(event, handler) { listeners.set(event, [...(listeners.get(event) ?? []), handler]); },
        removeListener(event, handler) { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== handler)); },
        emit(event, ...args) { for (const handler of listeners.get(event) ?? []) handler(...args); },
    };
}

/** A SillyBunny getContext() with one open group; Carol is muted. */
function createHostContext({ speakerPick = true } = {}) {
    const eventSource = createEventSource();
    const group = { id: 'group-1', chat_id: 'chat-1', activation_strategy: 0,
        members: ['alice.png', 'bob.png', 'carol.png', 'dave.png'], disabled_members: ['carol.png'] };
    const context = {
        groupId: 'group-1', chatId: 'chat-1', groups: [group], chat: [],
        characters: [{ name: 'Alice', avatar: 'alice.png' }, { name: 'Bob', avatar: 'bob.png' },
            { name: 'Carol', avatar: 'carol.png' }, { name: 'Dave', avatar: 'dave.png' }],
        extensionSettings: {}, eventSource,
        eventTypes: { CHAT_CHANGED: 'chat_id_changed', GROUP_UPDATED: 'group_updated',
            GROUP_SPEAKER_SELECTION_CHANGED: 'group_speaker_selection_changed' },
    };
    if (speakerPick) {
        let pick = '';
        // Mirrors SillyBunny's setter: enabled members of the open group only, '' clears, changes are announced.
        context.getSelectedGroupSpeakerAvatar = () => pick;
        context.setSelectedGroupSpeakerAvatar = avatar => {
            if (typeof avatar !== 'string') return false;
            if (avatar && (!group.members.includes(avatar) || group.disabled_members.includes(avatar))) return false;
            if (pick !== avatar) {
                pick = avatar;
                eventSource.emit(context.eventTypes.GROUP_SPEAKER_SELECTION_CHANGED, avatar);
            }
            return true;
        };
    }
    return context;
}

function createSettings(initial = {}) {
    let value = initial;
    const listeners = new Set();
    return {
        get: () => value,
        update(patch) { value = { ...value, ...patch }; for (const listener of listeners) listener(); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
}

function createController(context, settingsValue = {}) {
    const host = createHostAdapter({ getContext: () => context });
    const settings = createSettings(settingsValue);
    const scene = createSceneStore({ host, settings });
    const controller = createTurnController({ host, settings, scene, decide: evaluateReplyRules, createRoutingController });
    return { host, controller, scene };
}

describe('host speaker pick', () => {
    test('makes Choose next responder available without the routing lease', () => {
        const withPick = createHostAdapter({ getContext: () => createHostContext() }).routingCapabilities();
        const withoutPick = createHostAdapter({ getContext: () => createHostContext({ speakerPick: false }) }).routingCapabilities();

        assert.equal(withPick.nativeSpeaker, true);
        assert.equal(withPick.automatic, false);
        assert.equal(withoutPick.nativeSpeaker, false);
    });

    test('sets and reads the pick for enabled members of the open conversation', () => {
        const context = createHostContext();
        const host = createHostAdapter({ getContext: () => context });

        assert.equal(host.setNextSpeaker('bob.png', conversationKey), true);
        assert.equal(context.getSelectedGroupSpeakerAvatar(), 'bob.png');
        assert.equal(host.getNextSpeaker(), 'bob.png');
    });

    test('refuses muted cards and stale conversations', () => {
        const context = createHostContext();
        const host = createHostAdapter({ getContext: () => context });

        assert.equal(host.setNextSpeaker('carol.png', conversationKey), false);
        assert.equal(host.setNextSpeaker('bob.png', JSON.stringify(['group-1', 'older-chat'])), false);
        assert.equal(context.getSelectedGroupSpeakerAvatar(), '');
    });

    test('ignores a pick the open conversation cannot use', () => {
        const context = createHostContext();
        const host = createHostAdapter({ getContext: () => context });
        context.setSelectedGroupSpeakerAvatar('bob.png');
        context.groups[0].disabled_members.push('bob.png');

        assert.equal(host.getNextSpeaker(), undefined);
    });

    test('refreshes views when the host pick changes', () => {
        const context = createHostContext();
        const host = createHostAdapter({ getContext: () => context });
        let refreshes = 0;
        const cleanup = host.onContextChanged(() => refreshes++);

        context.setSelectedGroupSpeakerAvatar('alice.png');
        cleanup();
        context.setSelectedGroupSpeakerAvatar('bob.png');

        assert.equal(refreshes, 1);
    });
});

describe('Choose next responder on the speaker bar', () => {
    test('picks the card in the speaker bar and reports it as the next responder', () => {
        const context = createHostContext();
        const { controller } = createController(context);

        assert.deepEqual(controller.stageResponder('bob.png', conversationKey), { ok: true, reason: '' });
        assert.equal(context.getSelectedGroupSpeakerAvatar(), 'bob.png');
        assert.deepEqual(controller.getRoutingState().staged, ['bob.png']);
    });

    test('shows a pick made in the speaker bar as the next responder', () => {
        const context = createHostContext();
        const { controller } = createController(context);
        context.setSelectedGroupSpeakerAvatar('alice.png');

        assert.deepEqual(controller.getRoutingState().staged, ['alice.png']);
    });

    test('Clear next responder clears the speaker bar pick', () => {
        const context = createHostContext();
        const { controller } = createController(context);
        context.setSelectedGroupSpeakerAvatar('bob.png');

        controller.clearStagedResponder();

        assert.equal(context.getSelectedGroupSpeakerAvatar(), '');
        assert.deepEqual(controller.getRoutingState().staged, []);
    });

    test('refuses cards that are absent, muted or excluded from Reply Rules', () => {
        const context = createHostContext();
        const { controller } = createController(context, {
            scene_controls: true,
            current_scenes: { version: 1, chats: { [conversationKey]: { members: { 'alice.png': 'absent' } } } },
            reply_rules: { characters: { 'dave.png': { enabled: false } } },
        });

        for (const avatar of ['alice.png', 'carol.png', 'dave.png']) {
            assert.equal(controller.stageResponder(avatar, conversationKey).ok, false);
            assert.equal(context.getSelectedGroupSpeakerAvatar(), '');
        }
        assert.equal(controller.stageResponder('bob.png', conversationKey).ok, true);
    });

    test('refuses a next responder while Reply Rules limits permit no replies', () => {
        const context = createHostContext();
        const { controller } = createController(context, { reply_rules: { maxResponses: 0 } });

        assert.equal(controller.stageResponder('bob.png', conversationKey).ok, false);
        assert.equal(context.getSelectedGroupSpeakerAvatar(), '');
    });

    test('clears the speaker bar pick when its card leaves the current scene', () => {
        const context = createHostContext();
        const { controller, scene } = createController(context, { scene_controls: true });
        controller.stageResponder('bob.png', conversationKey);

        assert.equal(scene.setState('bob.png', 'absent', conversationKey).ok, true);

        assert.equal(context.getSelectedGroupSpeakerAvatar(), '');
        assert.equal(controller.getState().status, 'The staged character is no longer eligible.');
    });

    test('clears a speaker bar pick of a card that Reply Rules exclude', () => {
        const context = createHostContext();
        const { controller } = createController(context, { reply_rules: { characters: { 'dave.png': { enabled: false } } } });

        context.setSelectedGroupSpeakerAvatar('dave.png');

        assert.equal(context.getSelectedGroupSpeakerAvatar(), '');
        assert.equal(controller.getState().status, 'The staged character is no longer eligible.');
    });

    test('drops the not-eligible notice once an eligible card is picked', () => {
        const context = createHostContext();
        const { controller } = createController(context, { reply_rules: { characters: { 'dave.png': { enabled: false } } } });
        context.setSelectedGroupSpeakerAvatar('dave.png');

        context.setSelectedGroupSpeakerAvatar('bob.png');

        assert.equal(context.getSelectedGroupSpeakerAvatar(), 'bob.png');
        assert.equal(controller.getState().status, '');
    });

    test('keeps the old behaviour on hosts without a speaker pick', () => {
        const context = createHostContext({ speakerPick: false });
        const { controller } = createController(context);

        assert.equal(controller.stageResponder('bob.png', conversationKey).ok, false);
        assert.deepEqual(controller.getRoutingState().staged, []);
    });
});
