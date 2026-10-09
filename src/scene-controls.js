function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

export function createSceneControls({ scene, getSelectedAvatar }) {
    let destroyed = false;
    const cleanups = [];
    const listen = (node, event, callback) => {
        node.addEventListener(event, callback);
        cleanups.push(() => node.removeEventListener(event, callback));
    };
    const root = element('details', undefined, 'sbu-scene-controls');
    root.id = 'sbu-scene-controls';
    root.append(element('summary', 'Current scene'));
    const body = element('div', undefined, 'sbu-scene-body');
    const enabledLabel = element('label', undefined, 'sbu-scene-toggle');
    const enabled = element('input');
    enabled.type = 'checkbox'; enabled.id = 'sbu-scene-enabled';
    enabledLabel.htmlFor = enabled.id;
    enabledLabel.append(enabled, element('span', 'Enable current-scene controls'));
    const hint = element('p', 'Current state is saved for this conversation. Unspecified members have no scene restriction. Mute and membership stay separate. Native routing remains independent; no history is filtered.', 'sbu-members-hint');
    const warning = element('p', '', 'sbu-members-hint');
    const current = element('p', '', 'sbu-scene-current');
    const actions = element('div', undefined, 'sbu-scene-actions');
    const result = element('p', '', 'sbu-members-status'); result.setAttribute('role', 'status');
    let key;
    let avatar;
    let lastSelection;
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
    listen(enabled, 'change', () => {
        const outcome = scene.setEnabled(enabled.checked);
        result.textContent = outcome.ok ? (enabled.checked ? 'Scene controls enabled.' : 'Scene controls disabled. Saved choices are kept.') : outcome.reason;
        refresh();
    });
    body.append(enabledLabel, hint, warning, current, actions, result);
    root.append(body);
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
    }
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch (error) { console.warn('[Group Utilities] Scene controls cleanup failed', error); }
        }
        root.remove();
    }
    try { cleanups.push(scene.subscribe(refresh)); refresh(); }
    catch (error) { destroy(); throw error; }
    return { element: root, refresh, destroy };
}
