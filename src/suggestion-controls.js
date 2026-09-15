function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

/** Explicit, reviewed scene suggestions. Neither the draft nor suggestions are persisted. */
export function createSuggestionControls({ host, settings, controller, adapter }) {
    const mount = document.getElementById('sbu-scene-suggestions-settings');
    if (!mount) throw new Error('Scene suggestion settings container is unavailable.');
    const root = node('details', undefined, 'sbu-reply-rules'); root.id = 'sbu-scene-suggestions';
    root.append(node('summary', 'Scene suggestions (optional)'));
    const body = node('div', undefined, 'sbu-reply-rules-body');
    const enabledLabel = node('label', undefined, 'sbu-rule-field');
    const enabled = node('input'); enabled.type = 'checkbox'; enabled.id = 'sbu-suggestions-enabled';
    enabledLabel.htmlFor = enabled.id;
    enabledLabel.append(node('span', 'Enable model-assisted scene suggestions'), enabled);
    const disclosure = node('p', 'Each request uses the selected connection and may cost money and take time. Only the scene description below, exact card filenames, names, and current scene states are sent. Chat history, notes, and the composer draft are not included. Review before applying; suggestions can be wrong.', 'sbu-responder-hint');
    const profileLabel = node('label', 'Connection profile (direct OpenAI only)');
    const profile = node('select'); profile.id = 'sbu-suggestion-profile'; profileLabel.htmlFor = profile.id;
    const inputLabel = node('label', 'Describe the current scene');
    const input = node('textarea'); input.id = 'sbu-suggestion-description'; input.rows = 3; input.maxLength = 4000;
    inputLabel.htmlFor = input.id;
    const actions = node('div', undefined, 'sbu-responder-actions');
    const request = node('button', 'Suggest scene changes', 'menu_button'); request.type = 'button'; request.id = 'sbu-suggestion-request';
    const clear = node('button', 'Stop / clear suggestions', 'menu_button'); clear.type = 'button'; clear.id = 'sbu-suggestion-clear';
    const status = node('p', '', 'sbu-responder-status'); status.setAttribute('role', 'status');
    const gate = node('p', '', 'sbu-responder-hint'); gate.id = 'sbu-suggestion-gate';
    request.setAttribute('aria-describedby', gate.id);
    const list = node('ul'); list.id = 'sbu-suggestion-list';
    let destroyed = false;
    let shownKey;
    let profileSignature;
    let rendered = [];
    const cleanups = [];
    const listen = (element, event, handler) => {
        element.addEventListener(event, handler);
        cleanups.push(() => element.removeEventListener(event, handler));
    };
    function refresh() {
        if (destroyed) return;
        const key = host.activeConversation()?.key;
        if (key !== shownKey) { input.value = ''; shownKey = key; }
        const config = settings.get();
        enabled.checked = config.scene_suggestions === true;
        const selected = typeof config.suggestion_profile === 'string' ? config.suggestion_profile : '';
        const profiles = adapter.getProfiles();
        const signature = JSON.stringify([selected, profiles]);
        if (signature !== profileSignature) {
            profile.replaceChildren();
            const empty = node('option', 'Choose a profile'); empty.value = ''; profile.append(empty);
            for (const item of profiles) {
                const option = node('option', `${item.name} (${item.model})`); option.value = item.id; profile.append(option);
            }
            if (selected && !profiles.some(item => item.id === selected)) {
                const unavailable = node('option', 'Saved profile currently unavailable'); unavailable.value = selected; profile.append(unavailable);
            }
            profile.value = selected; profileSignature = signature;
        }
        profile.disabled = !enabled.checked;
        input.disabled = !enabled.checked;
        const permission = controller.canSuggest(selected);
        request.disabled = !permission.allowed || !input.value.trim();
        gate.textContent = permission.allowed ? 'One request at a time. Speaker selection and automatic routing remain unchanged.' : permission.reason;
        status.textContent = controller.getState().status;
        const proposals = controller.getSceneSuggestions();
        if (proposals.length !== rendered.length || proposals.some((proposal, index) => proposal !== rendered[index])) {
            list.replaceChildren();
            for (const proposal of proposals) {
                const row = node('li');
                row.append(node('p', `${proposal.avatar}: ${proposal.from} → ${proposal.to}. ${proposal.reason}`));
                const apply = node('button', `Apply change for ${proposal.avatar}`, 'menu_button'); apply.type = 'button';
                apply.addEventListener('click', () => { controller.applySceneSuggestion(proposal); refresh(); });
                row.append(apply); list.append(row);
            }
            rendered = proposals;
        }
    }
    actions.append(request, clear);
    body.append(enabledLabel, disclosure, profileLabel, profile, inputLabel, input, actions, gate, status, list);
    root.append(body);
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch (error) { console.warn('[Group Utilities] Suggestion controls cleanup failed', error); }
        }
        root.remove();
    }
    try {
        listen(enabled, 'change', () => settings.update({ scene_suggestions: enabled.checked }));
        listen(profile, 'change', () => settings.update({ suggestion_profile: profile.value }));
        listen(input, 'input', () => { controller.clearSceneSuggestions(); refresh(); });
        listen(request, 'click', async () => {
            const key = shownKey;
            const instruction = input.value;
            const result = await controller.requestSceneSuggestions({ profileId: profile.value, instruction });
            refresh();
            if (!destroyed && !result.ok && shownKey === key && input.value === instruction) status.textContent = result.reason;
        });
        listen(clear, 'click', () => { controller.clearSceneSuggestions(); refresh(); });
        listen(root, 'keydown', event => {
            if (event.key === 'Enter' && event.target.closest('button, input, select, textarea')) event.stopPropagation();
        });
        cleanups.push(settings.subscribe(refresh));
        cleanups.push(host.onContextChanged(refresh));
        cleanups.push(controller.subscribe(refresh));
        mount.append(root);
        refresh();
    } catch (error) { destroy(); throw error; }
    return { refresh, destroy };
}
