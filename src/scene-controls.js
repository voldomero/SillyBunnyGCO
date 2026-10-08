// Siblings load with this module's asset token, as groupUtils.js does, so a GCO update never mixes cached files.
const sibling = path => {
    const url = new URL(path, import.meta.url);
    const token = new URL(import.meta.url).searchParams.get('v') ?? globalThis.window?.SillyBunnyGroupUtilities?.assetToken;
    if (token) url.searchParams.set('v', token);
    return url.href;
};
const { SCENE_TEXT } = await import(sibling('./scene-text.js'));

const STATUS_WORDS = { present: SCENE_TEXT.P6present, absent: SCENE_TEXT.P6absent, remote: SCENE_TEXT.P6remote,
    unspecified: SCENE_TEXT.P6unspecified };

const COMPOSER_IDS = ['send_textarea', 'file_form_input'];

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function toggleRow(id, text) {
    const label = element('label', undefined, 'sbu-scene-toggle');
    const input = element('input');
    input.type = 'checkbox'; input.id = id;
    label.htmlFor = id;
    label.append(input, element('span', text));
    return { label, input };
}

function describedToggle(id, text, hintText) {
    const row = toggleRow(id, text);
    const hint = element('p', hintText, 'sbu-members-hint');
    hint.id = `${id}-hint`;
    row.input.setAttribute('aria-describedby', hint.id);
    return { ...row, hint };
}

/** The status line's state and text (§11, §13): host limits first, then off, Vocalia, a filter error, automatic. */
function memoryState({ capable, history, steppedAside, lastError }) {
    if (!capable.history) return ['unavailable-history', SCENE_TEXT.P16];
    if (!history) return ['off', SCENE_TEXT.P4off];
    if (steppedAside) return ['vocalia', SCENE_TEXT.P14];
    if (lastError) return ['error', SCENE_TEXT.P18];
    if (!capable.automatic) return ['unavailable-automatic', SCENE_TEXT.P17];
    return ['on', SCENE_TEXT.P4];
}

export function createSceneControls({ scene, sceneMemory, settings, getSelectedAvatar }) {
    let destroyed = false;
    const cleanups = [];
    const listen = (node, event, callback, capture = false) => {
        node.addEventListener(event, callback, capture);
        cleanups.push(() => node.removeEventListener(event, callback, capture));
    };
    // Each composer keystroke refreshes the panel several times, yet it cannot move the scene. An event's phase
    // returns to NONE (0) when its dispatch ends, so this is true only inside that keystroke's own listeners.
    let composerEvent;
    const noteComposer = event => {
        if (COMPOSER_IDS.includes(event.target?.id)) composerEvent = event;
    };
    const typing = () => Boolean(composerEvent?.eventPhase);
    const memoryReady = Boolean(sceneMemory && settings);
    const root = element('details', undefined, 'sbu-scene-controls');
    root.id = 'sbu-scene-controls';
    root.append(element('summary', 'Current scene'));
    const body = element('div', undefined, 'sbu-scene-body');
    const enabledLabel = element('label', undefined, 'sbu-scene-toggle');
    const enabled = element('input');
    enabled.type = 'checkbox'; enabled.id = 'sbu-scene-enabled';
    enabledLabel.htmlFor = enabled.id;
    enabledLabel.append(enabled, element('span', 'Enable current-scene controls'));
    const hint = element('p', SCENE_TEXT.R1, 'sbu-members-hint');
    const warning = element('p', '', 'sbu-members-hint');
    const memorySection = element('div', undefined, 'sbu-scene-memory');
    const memory = describedToggle('sbu-scene-memory', SCENE_TEXT.P1, SCENE_TEXT.P1h);
    const automatic = describedToggle('sbu-scene-auto', SCENE_TEXT.P2, SCENE_TEXT.P2h);
    const status = element('p', undefined, 'sbu-scene-memory-status');
    status.id = 'sbu-scene-memory-status'; status.setAttribute('role', 'status');
    const statusText = element('span', '', 'sbu-scene-memory-status-text');
    const statusError = element('span', '', 'sbu-scene-memory-error');
    status.append(statusText, statusError);
    memorySection.append(memory.label, memory.hint, automatic.label, automatic.hint, status);
    const changes = element('div', undefined, 'sbu-scene-changes');
    changes.id = 'sbu-scene-changes';
    const changesTitle = element('h3', SCENE_TEXT.P5, 'sbu-scene-heading');
    changesTitle.id = 'sbu-scene-changes-title'; changesTitle.tabIndex = -1;
    const changeList = element('ul', undefined, 'sbu-scene-change-list');
    changeList.setAttribute('aria-labelledby', changesTitle.id);
    const changesEmpty = element('p', SCENE_TEXT.P9, 'sbu-members-hint sbu-scene-changes-empty');
    changes.append(changesTitle, changeList, changesEmpty);
    const current = element('p', '', 'sbu-scene-current');
    const join = element('p', undefined, 'sbu-scene-join');
    join.id = 'sbu-scene-join';
    const joinText = element('span', '', 'sbu-scene-join-text');
    const joinLast = element('span', '', 'sbu-scene-join-last');
    const joinCount = element('span', '', 'sbu-scene-join-count');
    join.append(joinText, joinLast, joinCount);
    const omniscient = toggleRow('sbu-scene-omniscient', SCENE_TEXT.P3);
    const actions = element('div', undefined, 'sbu-scene-actions');
    const result = element('p', '', 'sbu-members-status'); result.setAttribute('role', 'status');
    result.tabIndex = -1;
    const reveal = element('button', SCENE_TEXT.P23, 'sbu-members-button sbu-scene-join-reveal');
    reveal.type = 'button'; reveal.id = 'sbu-scene-join-reveal';
    let key;
    let avatar;
    let lastSelection;
    let changesSignature;
    // Undo buttons by change id, so a rebuilt list can keep keyboard focus on the same row.
    let undoButtons = new Map();
    const buttons = new Map();
    for (const [id, label, target] of [
        ['arrive', 'Arrive', 'present'], ['depart', 'Depart', 'absent'],
        ['connect', 'Connect remotely', 'remote'], ['disconnect', 'Disconnect', 'absent'],
        ['absent', 'Set absent', 'absent'], ['clear', 'Clear scene state', 'unspecified'],
    ]) {
        const button = element('button', label, 'sbu-members-button');
        button.type = 'button'; button.id = `sbu-scene-${id}`;
        listen(button, 'click', () => {
            const outcome = scene.setState(avatar, target, key);
            result.textContent = outcome.ok ? `${label}: current scene updated. Earlier events are unchanged.` : outcome.reason;
            refresh();
        });
        buttons.set(id, button); actions.append(button);
    }
    actions.append(reveal);
    listen(enabled, 'change', () => {
        const outcome = scene.setEnabled(enabled.checked);
        result.textContent = outcome.ok ? (enabled.checked ? 'Scene controls enabled.' : 'Scene controls disabled. Saved choices are kept.') : outcome.reason;
        refresh();
    });
    const updateSetting = patch => {
        try { settings.update(patch); } catch (error) { console.warn('[Group Utilities] Scene memory setting failed to save', error); }
        refresh();
    };
    listen(memory.input, 'change', () => updateSetting({ scene_history: memory.input.checked }));
    listen(automatic.input, 'change', () => updateSetting({ scene_auto: automatic.input.checked }));
    listen(omniscient.input, 'change', () => {
        try { sceneMemory.setOmniscient(avatar, omniscient.input.checked); } catch (error) {
            console.warn('[Group Utilities] Knows everything failed to save', error);
        }
        refresh();
    });
    listen(reveal, 'click', () => {
        const target = avatar;
        let outcome = { ok: false };
        try { outcome = sceneMemory.forgetJoin(target); } catch (error) {
            console.warn('[Group Utilities] Join reveal failed', error);
        }
        refresh();
        result.textContent = outcome.ok ? SCENE_TEXT.P24 : SCENE_TEXT.P20;
        if (reveal.hidden && (document.activeElement === reveal || !root.contains(document.activeElement))) {
            result.focus({ preventScroll: true });
        }
    });
    listen(root, 'toggle', () => refresh());
    listen(document, 'input', noteComposer, true);
    listen(document, 'change', noteComposer, true);
    body.append(enabledLabel, hint, warning, memorySection, changes, current, join, omniscient.label, actions, result);
    root.append(body);

    function undoChange(id, position) {
        try { sceneMemory.undo(id); } catch (error) { console.warn('[Group Utilities] Scene change Undo failed', error); }
        refresh();
        if (root.contains(document.activeElement)) return;
        const remaining = [...undoButtons.values()];
        (remaining[Math.min(position, remaining.length - 1)] ?? changesTitle).focus({ preventScroll: true });
    }

    function changeRow(change, position) {
        const row = element('li', undefined, 'sbu-scene-change');
        row.dataset.avatar = change.avatar;
        row.dataset.from = change.from;
        row.dataset.to = change.to;
        row.dataset.index = String(change.index);
        row.dataset.pending = String(change.pending);
        const summary = element('span', undefined, 'sbu-scene-change-summary');
        summary.id = `sbu-scene-change-${position}`;
        const from = element('span', STATUS_WORDS[change.from] ?? '', 'sbu-scene-change-status');
        from.dataset.status = change.from;
        from.hidden = !Object.hasOwn(STATUS_WORDS, change.from);
        const arrow = element('span', '→', 'sbu-scene-change-arrow');
        arrow.setAttribute('aria-hidden', 'true');
        arrow.hidden = from.hidden;
        const to = element('span', STATUS_WORDS[change.to] ?? '', 'sbu-scene-change-status');
        to.dataset.status = change.to;
        summary.append(element('span', change.name, 'sbu-scene-change-name'), element('span', SCENE_TEXT.P6, 'sbu-scene-change-text'),
            from, arrow, to);
        row.append(summary);
        if (change.pending) row.append(element('span', SCENE_TEXT.P7, 'sbu-scene-change-pending'));
        const undo = element('button', SCENE_TEXT.P8, 'sbu-members-button sbu-scene-change-undo');
        undo.type = 'button';
        undo.setAttribute('aria-describedby', summary.id);
        undo.addEventListener('click', () => undoChange(change.id, position));
        row.append(undo);
        if (change.excerpt) row.append(element('span', change.excerpt, 'sbu-scene-change-excerpt'));
        undoButtons.set(change.id, undo);
        return row;
    }

    function renderChanges() {
        const list = sceneMemory.getChanges();
        const signature = JSON.stringify(list);
        if (signature === changesSignature) return;
        changesSignature = signature;
        const focused = [...undoButtons].find(([, button]) => button === document.activeElement)?.[0];
        undoButtons = new Map();
        changeList.replaceChildren(...list.map(changeRow));
        changeList.hidden = !list.length;
        changesEmpty.hidden = list.length > 0;
        if (focused !== undefined) undoButtons.get(focused)?.focus({ preventScroll: true });
    }

    function renderJoin(member) {
        const joined = member ? sceneMemory.joinStatus(avatar) : null;
        const known = Number.isFinite(joined?.joinedAt);
        join.hidden = !known;
        reveal.hidden = !known;
        if (!known) {
            delete join.dataset.state; delete join.dataset.lastIndex; delete join.dataset.count;
            return;
        }
        const off = Boolean(joined.off);
        join.dataset.state = off ? 'off' : 'joined';
        join.dataset.count = String(joined.hidden);
        if (Number.isInteger(joined.lastPreJoin)) join.dataset.lastIndex = String(joined.lastPreJoin);
        else delete join.dataset.lastIndex;
        joinText.textContent = off ? SCENE_TEXT.P22 : SCENE_TEXT.P21;
        joinLast.textContent = Number.isInteger(joined.lastPreJoin) ? `#${joined.lastPreJoin}` : '';
        joinLast.hidden = off || !joinLast.textContent;
        joinCount.textContent = String(joined.hidden);
        joinCount.hidden = off;
    }

    function refreshMemory(snapshot, member) {
        memorySection.hidden = !memoryReady;
        changes.hidden = true;
        omniscient.label.hidden = !memoryReady;
        if (!memoryReady) {
            join.hidden = true; reveal.hidden = true;
            return;
        }
        const state = sceneMemory.status();
        const config = settings.get();
        memory.input.checked = config.scene_history === true;
        memory.input.disabled = !snapshot.enabled || !state.capable.history;
        automatic.input.checked = config.scene_auto === true;
        automatic.input.disabled = !state.history || !state.capable.automatic;
        const [name, text] = memoryState(state);
        // A live region can announce a rewrite even when the text is the same, so only real changes are written.
        if (status.dataset.state !== name) status.dataset.state = name;
        if (statusText.textContent !== text) statusText.textContent = text;
        const error = name === 'error' ? String(state.lastError) : '';
        if (statusError.textContent !== error) statusError.textContent = error;
        if (statusError.hidden !== (name !== 'error')) statusError.hidden = name !== 'error';
        omniscient.input.checked = Boolean(member) && sceneMemory.isOmniscient(avatar);
        omniscient.input.disabled = !member || !state.history;
        changes.hidden = !state.history;
        // The list and join counts scan the whole chat, so they wait until someone can see them.
        if (!root.open || root.closest('[hidden]') || typing()) return;
        if (state.history) renderChanges();
        renderJoin(member);
    }

    function refresh() {
        if (destroyed) return;
        const snapshot = scene.getSnapshot();
        key = snapshot.key;
        avatar = getSelectedAvatar();
        const selection = JSON.stringify([key, avatar]);
        if (selection !== lastSelection) result.textContent = '';
        lastSelection = selection;
        enabled.checked = snapshot.enabled;
        enabled.disabled = !snapshot.supported && !snapshot.enabled;
        warning.textContent = [snapshot.warning, snapshot.orphaned.length ? `${snapshot.orphaned.length} saved card reference(s) are unavailable; their state has been kept.` : ''].filter(Boolean).join(' ');
        const member = snapshot.participants.find(item => item.avatar === avatar);
        const state = member?.status ?? 'unspecified';
        current.textContent = member ? `${member.name} [${member.avatar}]: ${state === 'remote' ? 'remotely connected' : state}` : 'Select a member in this conversation.';
        for (const [id, button] of buttons) {
            const applicable = id === 'depart' ? state === 'present' : id === 'disconnect' ? state === 'remote'
                : id === 'absent' ? state === 'unspecified' : id === 'clear' ? state !== 'unspecified'
                    : id === 'arrive' ? state !== 'present' : state !== 'remote';
            button.hidden = !applicable;
            button.disabled = !snapshot.enabled || !snapshot.supported || !member;
        }
        refreshMemory(snapshot, member);
    }
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch (error) { console.warn('[Group Utilities] Scene controls cleanup failed', error); }
        }
        root.remove();
    }
    try {
        cleanups.push(scene.subscribe(refresh));
        if (memoryReady) cleanups.push(sceneMemory.subscribe(refresh));
        refresh();
    } catch (error) { destroy(); throw error; }
    return { element: root, refresh, destroy };
}
