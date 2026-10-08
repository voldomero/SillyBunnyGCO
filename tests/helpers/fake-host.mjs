import { createHostAdapter } from '../../src/host-adapter.js';

/** SillyBunny's `event_types` values for every event scene memory listens to. */
export const EVENT_TYPES = Object.freeze({
    CHAT_CHANGED: 'chat_id_changed',
    GROUP_UPDATED: 'group_updated',
    CHARACTER_EDITED: 'character_edited',
    SETTINGS_UPDATED: 'settings_updated',
    GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    GROUP_WRAPPER_STARTED: 'group_wrapper_started',
    GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_DELETED: 'message_deleted',
    CHAT_DELETED: 'chat_deleted',
    CHARACTER_RENAMED: 'character_renamed',
    CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
    GROUP_SPEAKER_SELECTION_CHANGED: 'group_speaker_selection_changed',
});

const isoAt = ms => new Date(ms).toISOString();

/** Like SillyBunny's emitter: listeners run one at a time, in registration order, each awaited. */
function createEventSource() {
    const listeners = new Map();
    return {
        on(event, handler) { listeners.set(event, [...(listeners.get(event) ?? []), handler]); },
        removeListener(event, handler) { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== handler)); },
        async emit(event, ...args) {
            for (const handler of [...(listeners.get(event) ?? [])]) await handler(...args);
        },
        count: event => (listeners.get(event) ?? []).length,
    };
}

function createSettings(initial) {
    let value = { ...initial };
    const listeners = new Set();
    return {
        get: () => value,
        update(patch) {
            value = { ...value, ...patch };
            for (const listener of [...listeners]) listener();
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
}

/** A minimal moment stand-in: ISO strings and unix digits only. */
function timestampToMoment(value) {
    const ms = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
    return { isValid: () => Number.isFinite(ms), valueOf: () => ms };
}

/**
 * A fake SillyBunny `getContext()` with one open group chat and a real host adapter over it.
 * Members are Alice, Bob and Carol unless `members` says otherwise; every card in `cards` exists.
 */
export async function createFakeHost({
    members = ['alice.png', 'bob.png', 'carol.png'],
    cards = ['alice.png', 'bob.png', 'carol.png', 'dave.png'],
    chat = [],
    chatMetadata = { integrity: 'fake-integrity' },
    start = Date.UTC(2026, 9, 8, 1, 0, 0),
    settings: settingsFields = {},
    generating = false,
    saveResult = true,
} = {}) {
    let now = start;
    let isGenerating = generating;
    const clock = { now: () => now, tick(ms = 1000) { now += ms; return now; } };
    const eventSource = createEventSource();
    const saves = [];
    const toasts = [];
    const nameOf = avatar => avatar.replace(/\.png$/, '').replace(/^./, letter => letter.toUpperCase());
    const group = { id: 'g1', chat_id: 'c1', members: [...members], disabled_members: [], activation_strategy: 0 };
    const context = {
        groupId: 'g1',
        chatId: 'c1',
        groups: [group],
        characters: cards.map(avatar => ({ name: nameOf(avatar), avatar })),
        chat,
        chatMetadata,
        name1: 'User',
        extensionSettings: {},
        symbols: { ignore: Symbol('ignore') },
        eventSource,
        eventTypes: { ...EVENT_TYPES },
        timestampToMoment,
        saveResult,
        async saveChat(options) {
            saves.push({ options, length: context.chat.length, metadata: context.chatMetadata });
            return context.saveResult;
        },
    };
    const host = createHostAdapter({
        getContext: () => context,
        document: undefined,
        importModule: async () => ({ isGenerating: () => isGenerating }),
    });
    await host.prepareSuggestionSupport();
    host.toast = options => { toasts.push(options); };
    const settings = createSettings({
        scene_controls: true,
        scene_history: true,
        scene_auto: false,
        scene_history_since: '2026-10-08T00:00:00.000Z',
        current_scenes: null,
        reply_rules: null,
        ...settingsFields,
    });

    function message({ avatar, name, mes = '', is_user = false, is_system = false, send_date, extra = {}, type } = {}) {
        const date = send_date ?? isoAt(clock.now());
        const result = is_user
            ? { name: name ?? context.name1, is_user: true, is_system, send_date: date, mes, extra: { ...extra } }
            : { name: name ?? nameOf(avatar ?? 'narrator'), is_user: false, is_system, send_date: date, mes,
                original_avatar: avatar, extra: { ...extra, ...(type ? { type } : {}) } };
        result.swipe_id = 0;
        result.swipes = [mes];
        result.swipe_info = [{ send_date: date, extra: structuredClone(result.extra) }];
        return result;
    }

    async function emit(name, ...args) {
        await eventSource.emit(EVENT_TYPES[name] ?? name, ...args);
    }

    const entryOf = line => ({ send_date: line.send_date, extra: structuredClone(line.extra ?? {}) });

    /** The host's syncMesToSwipe: the shown text and a copy of `extra` go into the shown version's entry. */
    function syncShown(line) {
        if (!Array.isArray(line.swipes) || !Array.isArray(line.swipe_info)) return;
        line.swipes[line.swipe_id] = line.mes;
        line.swipe_info[line.swipe_id] = entryOf(line);
    }

    /** The host's syncSwipeToMes: the line shows a stored version, with a copy of that entry's `extra`. */
    function showVersion(line, swipeId) {
        const entry = line.swipe_info[swipeId];
        line.swipe_id = swipeId;
        line.mes = line.swipes[swipeId];
        line.send_date = entry?.send_date;
        line.extra = structuredClone(entry?.extra ?? {});
    }

    /** n>1 alternatives: each one is a copy of the line's `extra` at the moment the host adds it. */
    function addAlternatives(line, texts) {
        for (const text of texts) {
            line.swipes.push(text);
            line.swipe_info.push(entryOf(line));
        }
    }

    return {
        context,
        host,
        settings,
        clock,
        saves,
        toasts,
        group,
        emit,
        message,
        setGenerating(value) { isGenerating = value; },
        /** Replace the chat and header with new objects, as a load does, then announce it. */
        async openChat(messages = [], metadata = { integrity: 'fake-integrity' }) {
            context.chat = messages;
            context.chatMetadata = metadata;
            await emit('CHAT_CHANGED', context.chatId);
        },
        /** A user line: pushed (or inserted with `at`) and announced with MESSAGE_SENT. */
        async sendUser(mes, { at, emitEvent = true } = {}) {
            clock.tick();
            const line = message({ is_user: true, mes });
            const index = at === undefined ? context.chat.push(line) - 1 : (context.chat.splice(at, 0, line), at);
            if (emitEvent) await emit('MESSAGE_SENT', index);
            return index;
        },
        /**
         * A character line: pushed (or inserted with `at`) and announced with MESSAGE_RECEIVED.
         * A streamed reply has its swipe entry and alternatives before the event; otherwise the
         * host adds them after it, copying `extra` as it is then.
         */
        async receive(avatar, mes, type = 'normal', { at, emitEvent = true, streaming = true, alternatives = [] } = {}) {
            clock.tick();
            const line = message({ avatar, mes });
            if (streaming) addAlternatives(line, alternatives);
            else {
                delete line.swipe_id;
                delete line.swipes;
                delete line.swipe_info;
            }
            const index = at === undefined ? context.chat.push(line) - 1 : (context.chat.splice(at, 0, line), at);
            if (emitEvent) await emit('MESSAGE_RECEIVED', index, type);
            if (!streaming) {
                line.swipe_id = 0;
                line.swipes = [line.mes];
                line.swipe_info = [entryOf(line)];
                addAlternatives(line, alternatives);
            }
            return index;
        },
        /** Show another stored version of a line, as the host's swipe does (MESSAGE_SWIPED). */
        async swipeTo(id, swipeId) {
            const line = context.chat[id];
            syncShown(line);
            showVersion(line, swipeId);
            await emit('MESSAGE_SWIPED', id);
        },
        /**
         * A swipe that generates: the line shows '...' in a new version slot (MESSAGE_SWIPED).
         * With `keepText`, the line keeps the old version's text, as hosts that show '...' only on screen do.
         */
        async swipeGenerate(id, { keepText = false } = {}) {
            const line = context.chat[id];
            syncShown(line);
            line.swipe_id = line.swipes.length;
            if (!keepText) line.mes = '...';
            await emit('MESSAGE_SWIPED', id);
        },
        /** The host's endSwipe after a swipe got no reply: the newest stored version is shown again, with no event and no save. */
        revertSwipe(id) {
            const line = context.chat[id];
            showVersion(line, Math.max(0, line.swipes.length - 1));
        },
        /** The host's deleteSwipe: MESSAGE_SWIPE_DELETED, then MESSAGE_SWIPED when the shown version was deleted. */
        async deleteSwipe(id, swipeId) {
            const line = context.chat[id];
            const current = line.swipe_id;
            line.swipes.splice(swipeId, 1);
            line.swipe_info.splice(swipeId, 1);
            const newSwipeId = swipeId < current ? current - 1
                : swipeId > current ? current : Math.min(swipeId, line.swipes.length - 1);
            line.swipe_id = newSwipeId;
            await emit('MESSAGE_SWIPE_DELETED', { messageId: id, swipeId, newSwipeId });
            if (swipeId !== current) return;
            showVersion(line, newSwipeId);
            await emit('MESSAGE_SWIPED', id);
        },
        /** The reply that fills a generating swipe, as the host writes it (MESSAGE_RECEIVED 'swipe'). */
        async finishSwipe(id, mes, { streaming = true, alternatives = [] } = {}) {
            clock.tick();
            const line = context.chat[id];
            line.mes = mes;
            line.send_date = isoAt(clock.now());
            if (streaming) {
                syncShown(line);
                addAlternatives(line, alternatives);
            } else line.swipes.length++;
            await emit('MESSAGE_RECEIVED', id, 'swipe');
            if (!streaming) {
                syncShown(line);
                addAlternatives(line, alternatives);
            }
        },
        /** Continue the newest line: the text grows and is restamped (MESSAGE_RECEIVED 'continue'). */
        async continueLine(id, more, { streaming = true, emitEvent = true } = {}) {
            clock.tick();
            const line = context.chat[id];
            line.mes += more;
            line.send_date = isoAt(clock.now());
            if (streaming) syncShown(line);
            if (emitEvent) await emit('MESSAGE_RECEIVED', id, 'continue');
            if (!streaming) syncShown(line);
        },
        /** Add a card (when missing) and a member; GROUP_UPDATED is emitted unless `event` is false. */
        async addMember(avatar, { event = true } = {}) {
            if (!context.characters.some(character => character.avatar === avatar)) {
                context.characters.push({ name: nameOf(avatar), avatar });
            }
            group.members.push(avatar);
            if (event) await emit('GROUP_UPDATED');
        },
    };
}
