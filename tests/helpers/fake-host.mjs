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
        /** A character line: pushed (or inserted with `at`) and announced with MESSAGE_RECEIVED. */
        async receive(avatar, mes, type = 'normal', { at, emitEvent = true } = {}) {
            clock.tick();
            const line = message({ avatar, mes });
            const index = at === undefined ? context.chat.push(line) - 1 : (context.chat.splice(at, 0, line), at);
            if (emitEvent) await emit('MESSAGE_RECEIVED', index, type);
            return index;
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
