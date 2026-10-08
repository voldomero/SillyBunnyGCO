import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHostAdapter } from '../src/host-adapter.js';

function createContext(fields = {}) {
    const listeners = new Map();
    const group = { id: 'g1', chat_id: 'c1', members: ['a.png', 'a.png', 'ghost.png', ''], disabled_members: [] };
    return {
        groupId: 'g1', chatId: 'c1', groups: [group], chat: [],
        characters: [{ name: 'A', avatar: 'a.png' }, { name: 'B', avatar: 'b.png' }],
        extensionSettings: {},
        eventTypes: { MESSAGE_SENT: 'message_sent', CHAT_CHANGED: 'chat_id_changed' },
        eventSource: {
            on(event, handler) { listeners.set(event, [...(listeners.get(event) ?? []), handler]); },
            removeListener(event, handler) { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== handler)); },
            listeners: event => listeners.get(event) ?? [],
        },
        ...fields,
    };
}

const adapterFor = context => createHostAdapter({ getContext: () => context, document: undefined });

describe('scene memory host helpers', () => {
    test('reports scene memory capabilities', () => {
        const ignore = Symbol('ignore');
        assert.deepEqual(adapterFor(createContext()).memoryCapabilities(), { history: false, automatic: false });
        assert.deepEqual(adapterFor(createContext({ symbols: { ignore } })).memoryCapabilities(), { history: true, automatic: false });
        const full = createContext({ symbols: { ignore } });
        full.eventTypes.GROUP_WRAPPER_STARTED = 'group_wrapper_started';
        full.eventTypes.GROUP_WRAPPER_FINISHED = 'group_wrapper_finished';
        assert.deepEqual(adapterFor(full).memoryCapabilities(), { history: true, automatic: true });
        assert.equal(adapterFor(createContext({ symbols: { ignore: 'ignore' } })).ignoreSymbol(), undefined);
        assert.equal(adapterFor(full).ignoreSymbol(), ignore);
    });

    test('steps aside only for an enabled Vocalia history filter', () => {
        const competitor = extensionSettings => adapterFor(createContext({ extensionSettings })).historyCompetitor();
        assert.equal(competitor({ aspect_vocalia: { enabled: true } }), true);
        assert.equal(competitor({ aspect_vocalia: { enabled: true, occludeUnwitnessedHistory: true } }), true);
        assert.equal(competitor({ aspect_vocalia: { enabled: true, occludeUnwitnessedHistory: false } }), false);
        assert.equal(competitor({ aspect_vocalia: { enabled: false } }), false);
        assert.equal(competitor({ aspect_vocalia: { enabled: true },
            disabledExtensions: ['third-party/st-aspect-vocalia'] }), false);
        assert.equal(competitor({ group_speaker_router: { enabled: true, occludeUnwitnessedHistory: false } }), false);
        assert.equal(competitor({}), false);
    });

    test('lists raw member ids without resolving cards', () => {
        assert.deepEqual(adapterFor(createContext()).memberIds(), ['a.png', 'ghost.png']);
        assert.deepEqual(adapterFor(createContext({ groupId: null })).memberIds(), []);
        assert.deepEqual([...adapterFor(createContext()).cardAvatars()], ['a.png', 'b.png']);
        assert.deepEqual(adapterFor(createContext()).groupRosters(), [{ id: 'g1', members: ['a.png', 'a.png', 'ghost.png', ''] }]);
    });

    test('exposes the live chat metadata object', () => {
        const chatMetadata = { integrity: 'x' };
        assert.equal(adapterFor(createContext({ chatMetadata })).chatMetadata(), chatMetadata);
        assert.equal(adapterFor(createContext()).chatMetadata(), undefined);
    });

    test('reads line times through the host parser', () => {
        const valid = adapterFor(createContext({ timestampToMoment: () => ({ isValid: () => true, valueOf: () => 42 }) }));
        const invalid = adapterFor(createContext({ timestampToMoment: () => ({ isValid: () => false, valueOf: () => 42 }) }));
        assert.equal(valid.timeOf('October 8, 2026 1:00am'), 42);
        assert.ok(Number.isNaN(invalid.timeOf('October 8, 2026 1:00am')));
        assert.equal(adapterFor(createContext()).timeOf('2026-10-08T01:00:00.000Z'), Date.UTC(2026, 9, 8, 1));
        assert.equal(adapterFor(createContext()).timeOf(5), 5);
    });

    test('passes save options through', async () => {
        const seen = [];
        const host = adapterFor(createContext({ saveChat: async options => { seen.push(options); return false; } }));
        assert.equal(await host.saveChat({ allowShrink: true }), false);
        assert.deepEqual(seen, [{ allowShrink: true }]);
        assert.equal(await host.saveChat(), false);
        assert.deepEqual(seen[1], {});
        assert.equal(await adapterFor(createContext()).saveChat(), undefined);
    });

    test('lets the host await event handlers', async () => {
        const context = createContext();
        const calls = [];
        const cleanup = adapterFor(context).onHostEvents(['MESSAGE_SENT', 'MISSING_EVENT'], async (name, id) => {
            calls.push([name, id]);
            return 'done';
        });
        const [handler] = context.eventSource.listeners('message_sent');
        assert.equal(await handler(3), 'done');
        assert.deepEqual(calls, [['MESSAGE_SENT', 3]]);
        cleanup();
        assert.equal(context.eventSource.listeners('message_sent').length, 0);
    });

    test('shows a toast with an escaped action button', () => {
        const shown = [];
        const toastr = { info: (html, title, options) => { shown.push({ html, options }); return {}; } };
        const view = { toastr };
        const host = createHostAdapter({ getContext: () => createContext(), document: { defaultView: view } });
        let undone = 0;
        host.toast({ text: '<b>Bob</b> left', actionLabel: 'Undo', onAction: () => undone++ });
        assert.equal(shown.length, 1);
        assert.match(shown[0].html, /&lt;b&gt;Bob&lt;\/b&gt; left/);
        assert.match(shown[0].html, /class="sbu-toast-action menu_button"/);
        const button = { closest: selector => selector === '.sbu-toast-action' ? button : null };
        shown[0].options.onclick({ target: button });
        shown[0].options.onclick({ target: button });
        shown[0].options.onclick({ target: { closest: () => null } });
        assert.equal(undone, 1);
        assert.doesNotThrow(() => adapterFor(createContext()).toast({ text: 'no toastr' }));
    });

    test('shows an escaped toast detail in its own element after the text', () => {
        const shown = [];
        const toastr = { warning: html => { shown.push(html); return {}; } };
        const host = createHostAdapter({ getContext: () => createContext(), document: { defaultView: { toastr } } });
        host.toast({ level: 'warning', text: 'Joined', detail: '<i>Dave</i> (3)', actionLabel: 'Undo', onAction: () => {} });
        host.toast({ level: 'warning', text: 'Plain' });
        assert.match(shown[0], /^Joined <span class="sbu-toast-detail">&lt;i&gt;Dave&lt;\/i&gt; \(3\)<\/span> <button/);
        assert.equal(shown[1], 'Plain');
    });
});
