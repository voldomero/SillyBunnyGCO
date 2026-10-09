const panelRegistry = new WeakMap();
const geometryProperties = ['top', 'right', 'bottom', 'left', 'width', 'height', 'margin'];

export function getActiveConversation(context) {
    if (context?.groupId === null || context?.groupId === undefined || context?.groupId === '') return null;
    const matches = context.groups?.filter(item => String(item.id) === String(context.groupId));
    if (matches?.length !== 1) return null;
    const group = matches[0];
    const chatId = context.chatId ?? group.chat_id;
    const key = JSON.stringify([context.groupId, chatId ?? null]);
    return { key, chatKey: key, group, groupId: context.groupId, chatId };
}

export function resolveActiveMembers(context) {
    const group = getActiveConversation(context)?.group;
    if (!Array.isArray(group?.members) || !Array.isArray(context.characters)) return [];
    return [...new Set(group.members)].flatMap(avatar => {
        if (typeof avatar !== 'string' || !avatar) return [];
        const matches = context.characters.flatMap((character, characterId) => character?.avatar === avatar
            ? [{ avatar, name: character.name, character, characterId, disabled: Boolean(group.disabled_members?.includes(avatar)) }]
            : []);
        return matches.length === 1 ? matches : [];
    });
}

function nativeDescriptionPolicy(context, generationType) {
    const unknown = reason => ({ known: false, includedAvatars: [], reason });
    if (context.mainApi !== 'openai') return unknown('custom-story-template');
    const manager = context.promptManager;
    if (typeof manager?.isPromptDisabledForActiveCharacter !== 'function'
        || typeof manager?.getPromptById !== 'function') return unknown('unknown-prompt-policy');
    try {
        if (manager.isPromptDisabledForActiveCharacter('charDescription')) {
            return { known: true, includedAvatars: [], reason: 'description-disabled' };
        }
        const marker = manager.getPromptById('charDescription');
        if (!marker) return unknown('description-marker-unknown');
        if (marker.injection_position !== undefined && marker.injection_position !== 0) return unknown('description-depth');
        if (Array.isArray(marker.injection_trigger) && marker.injection_trigger.length) {
            const type = String(generationType || 'normal').toLowerCase().trim();
            // Filtered system markers can be re-added by the host's later merge.
            if (typeof manager.shouldTrigger !== 'function' || !manager.shouldTrigger(marker, type)) {
                return unknown('description-trigger-filtered');
            }
        }
        return null;
    } catch {
        return unknown('unknown-prompt-policy');
    }
}

export function getNativeDescriptionContext(context, speakerAvatar, generationType = 'normal') {
    const active = getActiveConversation(context);
    if (!active) return { known: false, includedAvatars: [], reason: 'no-active-group' };
    const members = resolveActiveMembers(context);
    const mode = Number(active.group.generation_mode ?? 0);
    if (![0, 1, 2].includes(mode)) return { known: false, includedAvatars: [], reason: 'unknown-mode' };
    const policy = nativeDescriptionPolicy(context, generationType);
    if (policy) return policy;
    const includedAvatars = members.filter(member => typeof member.character.description === 'string'
        && member.character.description.trim()
        && (member.avatar === speakerAvatar || (mode === 1 && !member.disabled) || mode === 2)).map(member => member.avatar);
    return { known: true, includedAvatars, reason: ['swap', 'append', 'append-disabled'][mode] };
}

export function getHostModuleUrl(filename, moduleUrl = import.meta.url) {
    return new URL(`../../../../${filename}`, moduleUrl).href;
}

export function createHostAdapter({
    getContext = () => globalThis.SillyTavern?.getContext(),
    document: documentObject = globalThis.document,
    importModule = url => import(url),
    jQuery = globalThis.jQuery,
} = {}) {
    let generationPending = false;
    let nativeModules;
    let nativeGenerating;
    let groupEditorModule;
    const context = () => getContext() ?? {};
    const view = documentObject?.defaultView ?? globalThis.window;
    const isMobileLayout = () => Boolean(context().isMobile?.()
        || view?.SillyBunnyShell?.isMobileViewport?.()
        || view?.matchMedia?.('(max-width: 1000px)').matches);

    async function prepareSuggestionSupport() {
        try {
            // Both inspected hosts export this from script.js, not from getContext().
            const module = await importModule('/script.js');
            nativeGenerating = typeof module.isGenerating === 'function' ? module.isGenerating : undefined;
        } catch { nativeGenerating = undefined; }
        return Boolean(nativeGenerating);
    }

    async function prepareSettingsPersistence() {
        try {
            const [script, user] = await Promise.all([
                importModule('/script.js'), importModule('/scripts/user.js'),
            ]);
            // Never use the host's default-user fallback after a failed account lookup.
            const account = () => user.accountsEnabled === false ? 'default-user'
                : user.accountsEnabled === true && typeof user.currentUser?.handle === 'string'
                    && user.currentUser.handle ? user.currentUser.handle : null;
            const accountKey = account();
            if (!accountKey || typeof script.saveSettings !== 'function') return null;
            return { accountKey,
                save: () => account() === accountKey
                    ? script.saveSettings(0, { returnResult: true }) : Promise.resolve(false) };
        } catch { return null; }
    }

    function onContextChanged(callback) {
        const current = context();
        const source = current.eventSource;
        const events = [...new Set(['CHAT_CHANGED', 'GROUP_UPDATED', 'CHARACTER_EDITED', 'SETTINGS_UPDATED',
            'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED']
            .map(name => current.eventTypes?.[name]).filter(Boolean))];
        const registered = [];
        const composerChanged = event => {
            if (['send_textarea', 'file_form_input'].includes(event.target?.id)) callback();
        };
        const cleanup = () => {
            for (const [event, handler] of registered.splice(0)) {
                if (source?.removeListener) source.removeListener(event, handler);
                else source?.off?.(event, handler);
            }
            documentObject?.removeEventListener?.('input', composerChanged);
            documentObject?.removeEventListener?.('change', composerChanged);
        };
        try {
            for (const event of events) {
                const handler = (...args) => {
                    callback(...args);
                };
                registered.push([event, handler]);
                source?.on?.(event, handler);
            }
            documentObject?.addEventListener?.('input', composerChanged);
            documentObject?.addEventListener?.('change', composerChanged);
        } catch (error) {
            cleanup();
            throw error;
        }
        return cleanup;
    }

    function onTurnEvent(callback) {
        const current = context();
        const registered = [];
        const cleanup = () => {
            for (const [event, handler] of registered.splice(0)) {
                if (current.eventSource?.removeListener) current.eventSource.removeListener(event, handler);
                else current.eventSource?.off?.(event, handler);
            }
        };
        try {
            for (const name of ['CHAT_CHANGED', 'GROUP_UPDATED', 'CHARACTER_EDITED', 'SETTINGS_UPDATED',
                'GENERATION_STARTED', 'GENERATION_STOPPED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
                'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_DELETED']) {
                const event = current.eventTypes?.[name];
                if (!event) continue;
                const handler = (...args) => callback(name, ...args);
                registered.push([event, handler]);
                current.eventSource?.on?.(event, handler);
            }
        } catch (error) { cleanup(); throw error; }
        return cleanup;
    }

    function routingCapabilities() {
        const disabled = context().extensionSettings?.disabledExtensions ?? [];
        const registry = context().extensionSettings;
        const groupId = context().groupId;
        const competitors = [
            ['Natural Extended', registry?.natural_extended?.[groupId]?.enabled, /natural[-_ ]?extended/i],
            ['Aspect: Vocalia', registry?.aspect_vocalia?.enabled || registry?.group_speaker_router?.enabled, /(?:vocalia|group.speaker.router)/i],
        ].filter(([, enabled]) => enabled === true)
            .filter(([, , pattern]) => !disabled.some(name => pattern.test(name)))
            .map(([name]) => name);
        const routing = context().groupTurnRouting;
        const supported = routing?.version === 1 && typeof routing.acquire === 'function';
        return {
            staged: supported, automatic: supported,
            reason: supported
                ? 'Routing is available for this conversation. Enable it explicitly; native strategy changes end this session.'
                : 'This host has no verified handoff before native speaker selection or owned completion contract. Choose next responder and automatic routing are unavailable.',
            competitors,
        };
    }

    function registerButton({ id, label, onClick, icon = 'fa-users' }, selector, shortcut) {
        const parent = documentObject?.querySelector(selector);
        if (!documentObject || (!parent && !shortcut)) throw new Error(`Group Members entry point unavailable: ${selector}`);
        if (documentObject.getElementById(id)) throw new Error(`Group Members entry point already exists: ${id}`);
        const button = documentObject.createElement('button');
        button.type = 'button';
        button.id = id;
        button.className = shortcut
            ? `sbu-members-shortcut gg-action-button menu_button menu_button_icon fa-solid ${icon}`
            : 'sbu-members-action menu_button';
        if (!shortcut) button.textContent = label;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', onClick);
        const keyboard = event => { if (event.key === 'Enter') event.stopPropagation(); };
        button.addEventListener('keydown', keyboard);
        parent?.append(button);
        let placementObserver;
        if (shortcut && view?.MutationObserver) {
            // Guided Generations rebuilds its action row; retain our button and its listeners.
            placementObserver = new view.MutationObserver(() => {
                const target = documentObject.querySelector(selector);
                if (target && button.parentElement !== target) target.append(button);
            });
            placementObserver.observe(documentObject.getElementById('send_form') ?? documentObject.body, { childList: true, subtree: true });
        }
        const cleanup = () => {
            placementObserver?.disconnect();
            button.removeEventListener('click', onClick);
            button.removeEventListener('keydown', keyboard);
            button.remove();
        };
        cleanup.element = button;
        return cleanup;
    }

    function isCurrentMembersOpen() {
        return Boolean(documentObject?.getElementById('groupMemberListPopout'));
    }

    function canOpenCurrentMembers() {
        if (isCurrentMembersOpen()) return jQuery && documentObject?.getElementById('groupMemberListPopoutClose')
            ? { allowed: true } : { allowed: false, reason: 'Current Members is unavailable in this host.' };
        if (!getActiveConversation(context())) return { allowed: false, reason: 'Open a group conversation to use Current Members.' };
        if (['create', 'group_create'].includes(context().menuType)) {
            return { allowed: false, reason: 'Finish or leave the new character or group editor before opening Current Members.' };
        }
        if (!jQuery || !documentObject?.getElementById('groupCurrentMemberPopoutButton')) {
            return { allowed: false, reason: 'Current Members is unavailable in this host.' };
        }
        return { allowed: true };
    }

    async function toggleCurrentMembers({ isCancelled = () => false } = {}) {
        if (isCancelled()) return { ok: false };
        const close = documentObject?.getElementById('groupMemberListPopoutClose');
        if (isCurrentMembersOpen() && close && jQuery) {
            jQuery(close).triggerHandler('click');
            return { ok: true };
        }
        const availability = canOpenCurrentMembers();
        if (!availability.allowed) return { ok: false, reason: availability.reason };
        const active = getActiveConversation(context());
        if (!active) return { ok: false };
        groupEditorModule ??= importModule(getHostModuleUrl('group-chats.js')).catch(error => {
            groupEditorModule = undefined;
            throw error;
        });
        const editor = await groupEditorModule;
        if (isCancelled() || getActiveConversation(context())?.key !== active.key) return { ok: false };
        const latestAvailability = canOpenCurrentMembers();
        if (!latestAvailability.allowed) return { ok: false, reason: latestAvailability.reason };
        if (isCurrentMembersOpen()) return { ok: true };
        if (typeof editor.select_group_chats !== 'function') {
            return { ok: false, reason: 'Current Members is unavailable in this host.' };
        }
        // Prepare the native editor without navigating the chat or changing the composer draft.
        if (String(editor.openGroupId) !== String(active.group.id)) editor.select_group_chats(active.group.id, true);
        if (isCancelled() || getActiveConversation(context())?.key !== active.key) return { ok: false };
        const opener = documentObject.getElementById('groupCurrentMemberPopoutButton');
        if (!opener) return { ok: false, reason: 'Current Members is unavailable in this host.' };
        // The hidden mobile opener still has its handler; avoid toggling the enclosing drawer.
        jQuery(opener).triggerHandler('click');
        return { ok: isCurrentMembersOpen() };
    }

    async function getNativeModules() {
        if (!nativeModules) {
            nativeModules = Promise.all([
                importModule(getHostModuleUrl('RossAscends-mods.js')),
                importModule(getHostModuleUrl('power-user.js')),
            ]).catch(error => { nativeModules = undefined; throw error; });
        }
        return nativeModules;
    }

    function attachPanel(element) {
        if (!documentObject || !element?.id) throw new Error('A named Group Members panel is required.');
        let registry = panelRegistry.get(documentObject);
        if (!registry) panelRegistry.set(documentObject, registry = new Map());
        const id = `${element.id}-host`;
        let record = registry.get(id);
        if (!record) {
            const wrapper = documentObject.createElement('div');
            wrapper.id = id;
            wrapper.className = 'sbu-native-panel draggable';
            wrapper.hidden = true;
            wrapper.addEventListener('mousedown', event => {
                const current = context();
                if (!current.powerUserSettings?.movingUI || isMobileLayout()) event.stopPropagation();
            }, true);
            record = { wrapper, bound: false, active: null };
            registry.set(id, record);
        }
        if (record.active) throw new Error('Group Members panel is already attached.');
        const { wrapper } = record;
        const token = {};
        record.active = token;
        let visible = false;
        let wasMobile = isMobileLayout();
        wrapper.replaceChildren(element);
        const header = element.querySelector('.drag-grabber');
        if (header) header.id = `${id}header`;
        (documentObject.getElementById('movingDivs') ?? documentObject.body).append(wrapper);

        const clearGeometry = () => {
            for (const property of geometryProperties) wrapper.style.removeProperty(property);
        };
        async function restoreDesktopLayout() {
            if (!context().powerUserSettings?.movingUI || isMobileLayout() || !jQuery) return;
            try {
                const [moving, power] = await getNativeModules();
                if (record.active !== token || !visible || isMobileLayout()
                    || !context().powerUserSettings?.movingUI) return;
                if (!record.bound) {
                    // The native API has no disposer. Reuse this wrapper and its one registration.
                    moving.dragElement(jQuery(wrapper));
                    record.bound = true;
                }
                power.loadMovingUIState();
            } catch (error) {
                console.warn('[SillyBunny Group Utilities] Native panel movement unavailable.', error);
            }
        }
        const onViewportChange = () => {
            if (record.active !== token) return;
            const mobile = isMobileLayout();
            if (mobile) clearGeometry();
            else if (wasMobile && visible) void restoreDesktopLayout();
            wasMobile = mobile;
        };
        view?.addEventListener?.('resize', onViewportChange);

        const handle = {
            element: wrapper,
            async show() {
                if (record.active !== token) return;
                visible = true;
                wrapper.hidden = false;
                wasMobile = isMobileLayout();
                if (wasMobile) clearGeometry();
                else await restoreDesktopLayout();
            },
            hide() {
                if (record.active !== token) return;
                visible = false;
                wrapper.hidden = true;
            },
            reset() {
                if (record.active !== token) return;
                const current = context();
                const saved = current.powerUserSettings?.movingUIState;
                if (saved && Object.hasOwn(saved, id)) {
                    delete saved[id];
                    current.saveSettingsDebounced?.();
                }
                clearGeometry();
            },
            destroy() {
                if (record.active !== token) return;
                visible = false;
                wrapper.hidden = true;
                wrapper.replaceChildren();
                view?.removeEventListener?.('resize', onViewportChange);
                record.active = null;
            },
        };
        return handle;
    }

    function canAskToRespond(avatar, expectedChatKey) {
        const current = context();
        const active = getActiveConversation(current);
        if (!active || (expectedChatKey !== undefined && expectedChatKey !== active.key)) {
            return { allowed: false, reason: 'The active conversation has changed.' };
        }
        // Native group generation uses strict ID lookup even though display resolution is tolerant.
        if (active.group.id !== current.groupId) {
            return { allowed: false, reason: 'The host cannot safely resolve this group for a native reply.' };
        }
        if (generationPending || current.streamingProcessor?.isFinished === false
            || documentObject?.getElementById('send_form')?.classList?.contains('sb-generating-controls')) {
            return { allowed: false, reason: 'Wait for the current response to finish.' };
        }
        const member = resolveActiveMembers(current).find(item => item.avatar === avatar);
        if (!member || typeof current.generate !== 'function') {
            return { allowed: false, reason: 'This character is no longer available in the active conversation.' };
        }
        if (documentObject?.getElementById('send_textarea')?.value) {
            return { allowed: false, reason: 'Finish or clear your draft before asking a character to respond.' };
        }
        if (documentObject?.getElementById('file_form_input')?.files?.length) {
            return { allowed: false, reason: 'Send or remove your pending attachment before asking a character to respond.' };
        }
        return { allowed: true, reason: '' };
    }

    async function askToRespond(avatar, expectedChatKey, { signal } = {}) {
        if (signal?.aborted || !canAskToRespond(avatar, expectedChatKey).allowed) return false;
        const current = context();
        const chatKey = getActiveConversation(current)?.key;
        const chat = current.chat;
        if (expectedChatKey !== undefined && chatKey !== expectedChatKey) return false;
        const member = resolveActiveMembers(current).find(item => item.avatar === avatar);
        if (!member || signal?.aborted) return false;
        generationPending = true;
        try {
            const options = { force_chid: member.characterId };
            // Only the audited host contract bridges caller cancellation to its owned request.
            if (signal && current.generationSupportsRequestControls === true) options.signal = signal;
            await current.generate('normal', options);
            const latest = context();
            return !signal?.aborted && getActiveConversation(latest)?.key === chatKey && latest.chat === chat;
        } finally {
            generationPending = false;
        }
    }

    return {
        getContext: context,
        prepareSuggestionSupport,
        prepareSettingsPersistence,
        isGenerating: () => nativeGenerating?.(),
        activeConversation: (current = context()) => getActiveConversation(current),
        resolveMembers: (current = context()) => resolveActiveMembers(current),
        nativeDescriptionContext: (current = context(), speakerAvatar, generationType = 'normal') => getNativeDescriptionContext(current, speakerAvatar, generationType),
        onContextChanged,
        onTurnEvent,
        routingCapabilities,
        registerAction: options => registerButton(options, '#extensionsMenu', false),
        registerShortcut: options => registerButton(options, '#gg-action-button-container .gg-regular-buttons-container', true),
        isCurrentMembersOpen,
        canOpenCurrentMembers,
        toggleCurrentMembers,
        attachPanel,
        canAskToRespond,
        askToRespond,
    };
}
