let instance;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label, onClick, className = '') {
    const node = element('button', `sbu-members-button ${className}`.trim(), label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

export function createMembersPanel({ host, settings, buildPreview, writeAs, askToRespond, getNote, setNote, scene, createSceneControls }) {
    if (instance) return instance;
    const panel = element('section', 'sbu-members-panel');
    panel.id = 'sbu-members-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'sbu-members-title');
    const header = element('header', 'sbu-members-header');
    const title = element('h2', '', 'Group Dynamics');
    title.id = 'sbu-members-title';
    title.tabIndex = -1;
    const grip = element('span', 'drag-grabber sbu-members-grip', '⋮⋮');
    grip.title = 'Move panel';
    grip.setAttribute('aria-hidden', 'true');
    const reset = button('Reset position', () => shell.reset(), 'sbu-members-reset');
    const closeButton = button('Close', () => close(), 'sbu-members-close');
    header.append(title, grip, closeButton);
    const content = element('div', 'sbu-members-content');
    const conversationLabel = element('p', 'sbu-members-conversation');
    const empty = element('p', 'sbu-members-empty', 'Open a group conversation to see its members.');
    const missing = element('p', 'sbu-members-hint');
    const roster = element('details', 'sbu-members-roster');
    const rosterSummary = element('summary', 'sbu-members-roster-summary', 'Group members');
    const list = element('div', 'sbu-members-list');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Members in this conversation');
    roster.append(rosterSummary, list);
    const detail = element('section', 'sbu-members-detail');
    const memberTitle = element('h3');
    memberTitle.tabIndex = -1;
    const availability = element('p', 'sbu-members-availability');
    const actions = element('div', 'sbu-members-actions');
    const writeButton = button('Write as', () => runAction('write'), 'sbu-members-write');
    const respondButton = button('Ask to respond', () => runAction('respond'), 'sbu-members-respond');
    actions.append(writeButton, respondButton);
    const actionStatus = element('p', 'sbu-members-status');
    actionStatus.setAttribute('role', 'status');
    const notes = element('details', 'sbu-members-notes');
    const notesSummary = element('summary', 'sbu-members-notes-summary', 'Shared note');
    const noteLabel = element('label', '', 'Shared note');
    noteLabel.htmlFor = 'sbu-members-note';
    const note = element('textarea', 'text_pole sbu-members-note');
    note.id = 'sbu-members-note';
    note.rows = 4;
    const noteHint = element('p', 'sbu-members-hint');
    const legacy = element('details', 'sbu-members-legacy');
    const legacySummary = element('summary', '', 'Older note with this name');
    const legacyText = element('pre');
    const recoverLegacy = button('Use legacy note for this card', () => {
        if (note.value) return;
        note.value = legacyText.textContent;
        saveNote(note.value);
    }, 'sbu-members-recover');
    legacy.append(legacySummary, legacyText, recoverLegacy);
    const noteStatus = element('p', 'sbu-members-status');
    noteStatus.setAttribute('role', 'status');
    notes.append(notesSummary, noteLabel, note, noteHint, legacy, noteStatus);
    detail.append(memberTitle, availability, actions, actionStatus, notes);
    const preview = element('details', 'sbu-members-preview');
    const previewSummary = element('summary', '', 'Context preview');
    const previewStatus = element('p', 'sbu-members-status');
    previewStatus.setAttribute('role', 'status');
    const previewText = element('pre', 'sbu-members-preview-text');
    const previewSpeaker = element('p', 'sbu-members-hint');
    const previewWarnings = element('ul', 'sbu-members-preview-warnings');
    const refreshPreview = button('Refresh preview', () => renderPreview());
    preview.append(previewSummary, previewSpeaker, previewStatus, previewText, previewWarnings, refreshPreview);
    content.append(conversationLabel, empty, missing, roster, detail, preview, reset);
    panel.append(header, content);

    let shell;
    let opened = false;
    let destroyed = false;
    let revision = 0;
    let selectedAvatar;
    let sceneControls;
    let selected;
    let conversation;
    let renderedSelectionKey;
    let opener;
    let busy = false;
    let shortcutCleanup;
    let shortcutEnabled = false;
    const cleanups = [];

    function selectionKey() {
        return `${conversation?.key ?? ''}\n${selectedAvatar ?? ''}`;
    }

    async function renderPreview() {
        const token = ++revision;
        previewText.textContent = '';
        previewSpeaker.textContent = '';
        previewWarnings.replaceChildren();
        if (!opened || !conversation?.group || !preview.open) return;
        previewStatus.textContent = 'Building preview…';
        try {
            const result = await buildPreview(selected?.avatar);
            if (destroyed || !opened || token !== revision || !preview.open) return;
            previewText.textContent = result.text || '';
            previewSpeaker.textContent = result.speaker?.name ? `Normal reply as ${result.speaker.name}` : '';
            previewStatus.textContent = result.text ? 'Additional context supplied by Group Utilities.' : 'No additional context is enabled for this conversation.';
            for (const warning of result.warnings ?? []) previewWarnings.append(element('li', '', warning));
            for (const omission of result.omissions ?? []) {
                previewWarnings.append(element('li', '', `${omission.name || 'Character'}: ${omission.reason}`));
            }
        } catch (error) {
            if (destroyed || !opened || token !== revision) return;
            previewStatus.textContent = 'Could not build the context preview.';
            console.warn('[Group Utilities] Preview failed', error);
        }
    }

    function refresh() {
        if (destroyed) return;
        revision++;
        const context = host.getContext();
        const previousKey = renderedSelectionKey;
        conversation = host.activeConversation(context) ?? { key: '', group: null };
        const members = conversation.group ? host.resolveMembers(context) : [];
        selected = members.find(member => member.avatar === selectedAvatar) ?? members[0];
        selectedAvatar = selected?.avatar;
        const changedSelection = previousKey !== selectionKey();
        renderedSelectionKey = selectionKey();
        conversationLabel.textContent = conversation.group
            ? `${conversation.group.name || 'Group conversation'} · ${members.length} ${members.length === 1 ? 'member' : 'members'}`
            : 'No active group conversation';
        empty.hidden = Boolean(conversation.group && members.length);
        empty.textContent = conversation.group ? 'This group has no available character cards.' : 'Open a group conversation to see its members.';
        missing.textContent = (conversation.group?.members?.length ?? 0) > members.length
            ? 'Some group members could not be resolved to a single character card.' : '';
        roster.hidden = !members.length;
        rosterSummary.textContent = `Group members (${members.length})`;
        detail.hidden = !selected;
        preview.hidden = !conversation.group;
        list.replaceChildren();
        for (const member of members) {
            const choice = button('', () => {
                selectedAvatar = member.avatar;
                refresh();
                (notes.open && !note.disabled ? note : memberTitle).focus({ preventScroll: true });
            }, 'sbu-members-choice');
            choice.dataset.avatar = member.avatar;
            choice.setAttribute('aria-pressed', String(member.avatar === selectedAvatar));
            choice.append(element('span', 'sbu-members-name', member.name), element('span', 'sbu-members-state', member.disabled ? 'Automatic replies off' : 'Automatic replies on'));
            if (members.filter(other => other.name === member.name).length > 1) {
                choice.append(element('span', 'sbu-members-state', member.avatar));
            }
            list.append(choice);
        }
        if (selected) {
            memberTitle.textContent = selected.name;
            availability.textContent = selected.disabled ? 'Automatic replies are off. You can still request a reply.' : 'Automatic replies are on.';
            noteLabel.textContent = `Shared note for ${selected.name}`;
            const savedNote = getNote(selected.character);
            if (changedSelection || document.activeElement !== note) note.value = savedNote.text ?? '';
            note.disabled = savedNote.editable === false;
            legacy.hidden = !savedNote.ambiguousLegacy || !savedNote.legacyText;
            legacyText.textContent = savedNote.legacyText ?? '';
            recoverLegacy.disabled = note.disabled || Boolean(savedNote.text);
            recoverLegacy.title = savedNote.text ? 'This card already has a note. Its current text is kept.' : '';
            noteHint.textContent = savedNote.ambiguousLegacy
                ? 'An older note has an ambiguous character name and has been left unchanged.'
                : settings.get().share_notes === false ? 'Note sharing is off. Your saved note is kept.' : '';
        }
        if (changedSelection) {
            actionStatus.textContent = '';
            noteStatus.textContent = '';
        }
        updateActionState();
        sceneControls?.refresh();
        syncShortcut();
        if (preview.open) void renderPreview();
    }

    function updateActionState() {
        writeButton.disabled = !selected || busy || host.canWriteAs?.() === false;
        const previousReason = respondButton.title;
        const availability = selected && host.canAskToRespond?.(selected.avatar, conversation?.key);
        respondButton.disabled = !selected || busy || availability?.allowed === false;
        respondButton.title = availability?.reason ?? '';
        if (!busy && availability?.allowed === false) actionStatus.textContent = availability.reason;
        else if (!busy && previousReason && actionStatus.textContent === previousReason) actionStatus.textContent = '';
    }

    async function runAction(kind) {
        if (!selected || busy || destroyed) return;
        const member = selected;
        const key = selectionKey();
        busy = true;
        actionStatus.textContent = kind === 'respond' ? 'Requesting a reply…' : '';
        updateActionState();
        try {
            const result = await (kind === 'write' ? writeAs : askToRespond)(member.character, conversation.key);
            if (destroyed || selectionKey() !== key) return;
            if (result === false || result?.ok === false) {
                actionStatus.textContent = result?.reason || 'The action is unavailable in the current conversation.';
                return;
            }
            actionStatus.textContent = result?.reason ?? '';
            if (kind === 'write' && (result === true || result?.ok === true)) close({ restoreFocus: false });
        } catch (error) {
            if (!destroyed && selectionKey() === key) actionStatus.textContent = 'Could not complete this action.';
            console.warn('[Group Utilities] Member action failed', error);
        } finally {
            busy = false;
            if (!destroyed) updateActionState();
        }
    }

    function syncShortcut() {
        const enabled = Boolean(settings.get().bottom_bar_shortcut);
        if (enabled === shortcutEnabled) return;
        shortcutCleanup?.();
        shortcutCleanup = undefined;
        if (enabled) shortcutCleanup = host.registerShortcut({ id: 'sbu-members-shortcut', label: 'Group Dynamics', onClick: toggle });
        shortcutEnabled = enabled;
        updateTriggers();
    }

    function updateTriggers() {
        for (const trigger of [document.getElementById('sbu-members-action'), shortcutCleanup?.element ?? document.getElementById('sbu-members-shortcut')]) {
            trigger?.setAttribute('aria-expanded', String(opened));
            trigger?.setAttribute('aria-controls', panel.id);
        }
    }

    async function open() {
        if (destroyed || opened) return;
        opener = document.activeElement;
        opened = true;
        updateTriggers();
        refresh();
        try { await shell.show(); } catch (error) {
            opened = false;
            updateTriggers();
            shell.hide();
            throw error;
        }
        if (destroyed || !opened) { shell.hide(); return; }
        title.focus({ preventScroll: true });
    }

    function close({ restoreFocus = true } = {}) {
        if (!opened) return;
        opened = false;
        updateTriggers();
        revision++;
        shell.hide();
        if (restoreFocus) {
            const target = [opener, document.getElementById('extensionsMenuButton'), document.getElementById('sbu-members-shortcut'), document.getElementById('send_textarea')]
                .find(node => node?.isConnected && node.getClientRects().length && !node.closest('.sbu-members-panel'));
            target?.focus({ preventScroll: true });
        }
    }

    function toggle() {
        if (opened) close();
        else void open().catch(error => {
            opened = false;
            shell.hide();
            console.warn('[Group Utilities] Members panel failed to open', error);
        });
    }

    function onKeyDown(event) {
        if (!opened || !(event.target instanceof Element) || !panel.contains(event.target)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'Enter' && event.target.closest('button, input, select, textarea, summary')) {
            event.stopPropagation();
        }
    }

    function saveNote(text) {
        if (!selected || note.disabled) return;
        const key = selectionKey();
        const character = selected.character;
        recoverLegacy.disabled = Boolean(text);
        noteStatus.textContent = 'Saving note…';
        Promise.resolve().then(() => setNote(character, text)).then(result => {
            if (!destroyed && selectionKey() === key) noteStatus.textContent = result === false ? 'The note could not be saved.' : 'Note saved.';
        }).catch(error => {
            if (!destroyed && selectionKey() === key) noteStatus.textContent = 'The note could not be saved.';
            console.warn('[Group Utilities] Member note failed to save', error);
        });
    }
    note.addEventListener('input', () => saveNote(note.value));
    preview.addEventListener('toggle', () => {
        if (preview.open) void renderPreview();
        else { revision++; previewText.textContent = ''; }
    });

    function destroy() {
        if (destroyed) return;
        close();
        destroyed = true;
        revision++;
        shortcutCleanup?.();
        for (const cleanup of cleanups.reverse()) cleanup?.();
        document.removeEventListener('keydown', onKeyDown, true);
        shell?.destroy();
        if (instance === api) instance = undefined;
    }

    const api = { element: panel, open, close, toggle, refresh, destroy };
    try {
        if (scene && createSceneControls) {
            const controls = createSceneControls({ scene, getSelectedAvatar: () => selectedAvatar });
            detail.prepend(controls.element);
            cleanups.push(() => controls.destroy());
            cleanups.push(scene.subscribe(refresh));
            sceneControls = controls;
        }
        shell = host.attachPanel(panel);
        document.addEventListener('keydown', onKeyDown, true);
        cleanups.push(host.registerAction({ id: 'sbu-members-action', label: 'Group Dynamics', onClick: toggle }));
        cleanups.push(host.onContextChanged(refresh));
        cleanups.push(settings.subscribe(refresh));
        updateTriggers();
        refresh();
        instance = api;
        return api;
    } catch (error) {
        destroy();
        throw error;
    }
}
