const extensionName = 'st-group-utils';
const promptKey = 'ub_grouputils';
const getContext = () => SillyTavern.getContext();
const dependencyUrl = path => {
    const url = new URL(path, import.meta.url);
    const token = new URL(import.meta.url).searchParams.get('v') ?? globalThis.window?.SillyBunnyGroupUtilities?.assetToken;
    if (token) url.searchParams.set('v', token);
    return url.href;
};
const [{ createAssetUrl }, store, { buildContext }, { createHostAdapter }, { createCleanupScope }, { createSceneStore }] = await Promise.all([
    import(dependencyUrl('./src/assets.js')),
    import(dependencyUrl('./src/settings.js')),
    import(dependencyUrl('./src/context-builder.js')),
    import(dependencyUrl('./src/host-adapter.js')),
    import(dependencyUrl('./src/lifecycle.js')),
    import(dependencyUrl('./src/scene-state.js')),
]);
export const assetUrl = createAssetUrl(import.meta.url);
const host = createHostAdapter({ getContext });
const settingsListeners = new Set();
let promptRevision = 0;
let disabled = false;
let heightModule;
let scene;
const options = (context = getContext()) => store.readSettings(context.extensionSettings);

export function resolveMembers(context, group = host.activeConversation(context)?.group) {
    return host.resolveMembers({ ...context, groupId: group?.id }).map(member => member.character);
}

function generatingCharacter(context, members) {
    if (context.characterId !== undefined && context.characterId !== null) {
        const character = context.characters[context.characterId];
        return members.includes(character) ? character : undefined;
    }
    const matches = members.filter(character => character.name === context.name2);
    return matches.length === 1 ? matches[0] : undefined;
}

// Kept as a compatibility read; new edits use the settings boundary's avatar key.
export function legacyNote(context, character) {
    if (!character || context.characters.filter(item => item.name === character.name).length !== 1) return undefined;
    const notes = options(context).character_data;
    return notes && Object.hasOwn(notes, character.name) ? notes[character.name] : undefined;
}

export function invalidatePrompt() {
    promptRevision++;
    getContext().setExtensionPrompt(promptKey, '', 1, 0);
}

function snapshotSignature(context, generationType = 'normal') {
    const active = host.activeConversation(context);
    const speaker = generatingCharacter(context, resolveMembers(context));
    return JSON.stringify([
        active?.key, context.characterId, context.name2, active?.group,
        host.nativeDescriptionContext(context, speaker?.avatar, generationType),
        options(context), context.characters.map(({ avatar, name, description, personality }) => [avatar, name, description, personality]),
    ]);
}

const emptyPreview = () => ({ text: '', descriptions: [], notes: [], heights: [], omissions: [], warnings: [] });
async function prepareContext(context, generationType = 'normal', speakerAvatar) {
    const active = host.activeConversation(context);
    if (!active) return emptyPreview();
    const members = resolveMembers(context, active.group);
    const speaker = speakerAvatar === undefined ? generatingCharacter(context, members)
        : members.find(character => character.avatar === speakerAvatar);
    if (speakerAvatar !== undefined && !speaker) return { ...emptyPreview(), stale: true };
    const result = await buildContext({
        snapshot: { members, speaker, characters: context.characters, scene: scene?.getSnapshot() },
        settings: options(context),
        countTokens: text => context.getTokenCountAsync(text),
        getNote: store.getCharacterNote,
        nativeDescriptionContext: host.nativeDescriptionContext(context, speaker?.avatar, generationType),
        heightAssistance: async input => {
            heightModule ??= import(assetUrl('./height_assistance.js')).catch(error => { heightModule = undefined; throw error; });
            return (await heightModule).onRearrangeChat(input);
        },
    });
    return { ...result, speaker: speaker ? { avatar: speaker.avatar, name: speaker.name } : null };
}

export async function buildPreview(speakerAvatar) {
    if (disabled) return emptyPreview();
    const context = getContext();
    const revision = promptRevision;
    const signature = snapshotSignature(context);
    const result = await prepareContext(context, 'normal', speakerAvatar);
    if (disabled || revision !== promptRevision || context.chat !== getContext().chat
        || signature !== snapshotSignature(getContext())) {
        return { ...emptyPreview(), stale: true, warnings: ['The conversation changed. Refresh the preview.'] };
    }
    return result;
}

export async function rearrangeChat(_chat, _contextSize, _abort, generationType = 'normal') {
    const revision = ++promptRevision;
    try {
        const context = getContext();
        context.setExtensionPrompt(promptKey, '', 1, 0);
        if (disabled || !host.activeConversation(context)) return;
        const signature = snapshotSignature(context, generationType);
        const chat = context.chat;
        const settings = options(context);
        const result = await prepareContext(context, generationType);
        if (disabled || revision !== promptRevision || getContext().chat !== chat
            || signature !== snapshotSignature(getContext(), generationType)) return;
        const position = Number(settings.position);
        const depth = Number(settings.depth);
        context.setExtensionPrompt(promptKey, result.text,
            Number.isFinite(position) ? position : store.defaults.position,
            Number.isFinite(depth) ? depth : store.defaults.depth,
            Boolean(settings.include_wi), 0);
    } catch (error) {
        console.error('[Group Utilities] Prompt preparation failed', error);
    }
}

function currentCharacter(character) {
    const matches = getContext().characters.filter(item => item.avatar === character?.avatar);
    return matches.length === 1 ? matches[0] : undefined;
}

function getNote(character) {
    const context = getContext();
    return store.getCharacterNote(options(context), currentCharacter(character), context.characters);
}

function settingsChanged() {
    invalidatePrompt();
    for (const listener of settingsListeners) {
        try { listener(); } catch (error) { console.warn('[Group Utilities] Settings view update failed', error); }
    }
}

function setNote(character, text) {
    const context = getContext();
    const stored = store.ensureSettings(context.extensionSettings);
    if (!store.setCharacterNote(stored, currentCharacter(character), context.characters, text)) return false;
    context.saveSettingsDebounced();
    settingsChanged();
    return true;
}

const settingsFacade = {
    get: () => options(),
    update(patch) {
        const context = getContext();
        const stored = store.ensureSettings(context.extensionSettings);
        for (const [key, value] of Object.entries(patch)) {
            if (Object.hasOwn(store.defaults, key)) stored[key] = value;
        }
        context.saveSettingsDebounced();
        settingsChanged();
    },
    subscribe(listener) {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
    },
};

function editorCharacter(context) {
    const form = document.getElementById('form_create');
    if (form?.getAttribute('actiontype') === 'createcharacter') return undefined;
    const avatar = document.getElementById('avatar_url_pole')?.value;
    if (avatar) {
        const matches = context.characters.filter(character => character.avatar === avatar);
        return matches.length === 1 ? matches[0] : undefined;
    }
    return context.characters[context.characterId];
}

export async function initialize() {
    const state = window.SillyBunnyGroupUtilities ??= {};
    if (state.groupUtilsLoaded) return state.groupUtilsCleanup;
    if (state.groupUtilsInitialization) return state.groupUtilsInitialization;
    state.groupUtilsInitialization = Promise.resolve().then(async () => {
        const scope = createCleanupScope();
        const context = getContext();
        const folder = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1));
        const ownExtension = name => name === `third-party/${folder}` || name === folder;
        const cleanup = () => {
            disabled = true;
            scope.dispose();
            state.groupUtilsLoaded = false;
            state.loadedModules?.delete('group-utils');
            delete state.groupUtilsApi;
            invalidatePrompt();
        };
        const on = (event, handler) => {
            if (!event) return;
            scope.add(() => context.eventSource.removeListener(event, handler));
            context.eventSource.on(event, handler);
        };
        try {
            on(context.eventTypes.EXTENSION_DISABLED, name => { if (ownExtension(name)) cleanup(); });
            const isDisabled = () => (getContext().extensionSettings.disabledExtensions ?? []).some(ownExtension);
            if (isDisabled()) throw new Error('Group Utilities is disabled');
            const [noteHtml, settingsHtml] = await Promise.all([
                $.get(assetUrl('./html/group-note.html')),
                $.get(assetUrl('./html/group-utils-settings.html')),
            ]);
            if (scope.closed || isDisabled()) throw new Error('Group Utilities initialization cancelled');
            const nativeNoteTarget = $('#depth_prompt_div');
            const legacyNoteTarget = $('#character_popup:not([hidden])');
            const settingsTarget = $('#extensions_settings2');
            if (!settingsTarget.length) throw new Error('Group Utilities settings container unavailable');
            const noteElement = $(noteHtml);
            const settingsElement = $(settingsHtml);
            scope.add(() => noteElement.remove());
            scope.add(() => settingsElement.remove());
            if (nativeNoteTarget.length) nativeNoteTarget.after(noteElement);
            else if (legacyNoteTarget.length) legacyNoteTarget.append(noteElement);
            settingsTarget.append(settingsElement);
            store.ensureSettings(context.extensionSettings);
            const refreshNote = () => {
                const character = editorCharacter(getContext());
                const note = getNote(character);
                const field = $('#group_note_pole');
                if (field.val() !== note.text) field.val(note.text);
                field.prop('disabled', !note.editable);
                noteElement.find('.sbu-legacy-note-warning').prop('hidden', !note.ambiguousLegacy);
            };
            const fields = {
                share_character_info: ['share_character_info', 'checkbox'],
                share_group_notes: ['share_notes', 'checkbox'],
                sbu_bottom_bar_shortcut: ['bottom_bar_shortcut', 'checkbox'],
                sbu_current_members_shortcut: ['current_members_shortcut', 'checkbox'],
                sbu_responder_picker: ['responder_picker', 'checkbox'],
                sbu_prose_styles: ['prose_styles', 'checkbox'],
                include_worldinfo: ['include_wi', 'checkbox'],
                share_stopper: ['share_stopper', 'text'],
                max_share_length: ['max_share_length', 'number'],
                max_characters: ['max_characters', 'number'],
                text_depth: ['depth', 'number'],
            };
            const refreshFields = () => {
                const settings = options();
                for (const [id, [key, type]] of Object.entries(fields)) {
                    const field = settingsElement.find(`#${id}`);
                    if (type === 'checkbox') field.prop('checked', settings[key]);
                    else field.val(settings[key]);
                }
            };
            for (const [id, [key, type]] of Object.entries(fields)) {
                settingsElement.find(`#${id}`).on('input.sbuGroupUtils', function () {
                    const value = type === 'checkbox' ? this.checked : type === 'number' ? Number(this.value) : this.value;
                    settingsFacade.update({ [key]: value });
                });
            }
            noteElement.find('#group_note_pole').on('input.sbuGroupUtils', function () {
                setNote(editorCharacter(getContext()), this.value);
            });
            settingsElement.find('#sbu-open-members').on('click.sbuGroupUtils', () => state.membersPanel?.toggle());
            settingsElement.find('button').on('keydown.sbuGroupUtils', event => { if (event.key === 'Enter') event.stopPropagation(); });
            settingsElement.find('.inline-drawer').on('inline-drawer-toggle.sbuGroupUtils', () => {
                settingsElement.find('.inline-drawer-header').attr('aria-expanded',
                    settingsElement.find('.inline-drawer-icon').hasClass('up') ? 'true' : 'false');
            });
            scope.add(settingsFacade.subscribe(() => { refreshFields(); refreshNote(); }));
            for (const [name, includeSpeaker] of [['char_list', false], ['char_list_all', true]]) {
                scope.add(() => context.unregisterMacro(name));
                context.registerMacro(name, () => {
                    const current = getContext();
                    const active = host.activeConversation(current);
                    if (!active) return current.name2;
                    const members = host.resolveMembers(current).filter(member => !member.disabled).map(member => member.character);
                    const speaker = generatingCharacter(current, members);
                    return members.filter(character => (includeSpeaker || character !== speaker)
                        && character.description).map(character => character.name).join(', ');
                });
            }
            on(context.eventTypes.CHAT_CHANGED, () => { invalidatePrompt(); refreshNote(); });
            on(context.eventTypes.CHARACTER_EDITOR_OPENED, refreshNote);
            on(context.eventTypes.CHARACTER_EDITED, () => { invalidatePrompt(); refreshNote(); });
            on(context.eventTypes.GROUP_UPDATED, invalidatePrompt);
            on(context.eventTypes.SETTINGS_UPDATED, () => { settingsChanged(); refreshNote(); });
            const previousInterceptor = window.groupUtils_generationInterceptor;
            scope.add(() => {
                if (window.groupUtils_generationInterceptor === rearrangeChat) {
                    if (previousInterceptor) window.groupUtils_generationInterceptor = previousInterceptor;
                    else delete window.groupUtils_generationInterceptor;
                }
            });
            window.groupUtils_generationInterceptor = rearrangeChat;
            refreshFields();
            refreshNote();
            scene = createSceneStore({ host, settings: settingsFacade });
            const ownedScene = scene;
            scope.add(() => { ownedScene.destroy(); if (scene === ownedScene) scene = undefined; });
            disabled = false;
            state.groupUtilsApi = { host, settings: settingsFacade, scene, buildPreview, getNote, setNote };
            state.groupUtilsCleanup = cleanup;
            state.groupUtilsLoaded = true;
            return cleanup;
        } catch (error) {
            cleanup();
            throw error;
        }
    });
    try { return await state.groupUtilsInitialization; }
    finally { state.groupUtilsInitialization = null; }
}
