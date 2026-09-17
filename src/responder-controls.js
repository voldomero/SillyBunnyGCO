function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

export function createResponderControls({ host, settings, controller, writeAs, normalizeRuleConfig }) {
    const mount = document.getElementById('sbu-reply-rules-settings');
    const composer = document.getElementById('send_textarea');
    if (!mount || !composer) throw new Error('Responder controls need the settings and composer containers.');
    const cleanups = [];
    let destroyed = false;
    let selectedAvatar;
    let shownKey;
    let memberSignature;
    let phraseSignature;
    let actionFeedback = '';
    const capabilities = host.routingCapabilities();
    const compact = node('section', undefined, 'sbu-responder-compact');
    compact.id = 'sbu-responder-compact';
    compact.setAttribute('aria-label', 'Responder controls');
    const pickerLabel = node('label', 'Responder');
    pickerLabel.htmlFor = 'sbu-responder-select';
    const picker = node('select');
    picker.id = 'sbu-responder-select';
    const compactActions = node('div', undefined, 'sbu-responder-actions');
    const button = (label, action, id) => {
        const element = node('button', label, 'menu_button');
        element.type = 'button';
        if (id) element.id = id;
        element.addEventListener('click', action);
        return element;
    };
    const selected = () => host.resolveMembers().find(member => member.avatar === selectedAvatar);
    const write = button('Write as', () => {
        const member = selected();
        if (member) writeAs(member.character, host.activeConversation()?.key);
    }, 'sbu-responder-write');
    const ask = button('Ask now', async () => {
        actionFeedback = '';
        const member = selected();
        const key = host.activeConversation()?.key;
        if (!member) return;
        const result = await controller.askToRespond(member.avatar, key);
        if (!destroyed && host.activeConversation()?.key === key) {
            requestStatus.textContent = result.reason ?? '';
            refresh();
        }
    }, 'sbu-responder-ask');
    const stage = button('Choose next responder', () => {
        const result = selectedAvatar && controller.stageResponder(selectedAvatar, host.activeConversation()?.key);
        actionFeedback = result?.ok === false ? result.reason : '';
        refresh();
    }, 'sbu-responder-stage');
    stage.disabled = true;
    stage.title = capabilities.reason;
    const clearRequest = button('Clear request', () => { actionFeedback = ''; controller.clear(); }, 'sbu-responder-clear');
    compactActions.append(write, ask, stage, clearRequest);
    const clearStage = button('Clear next responder', () => controller.clearStagedResponder(), 'sbu-responder-clear-stage');
    compactActions.append(clearStage);
    const requestStatus = node('p', '', 'sbu-responder-status');
    requestStatus.setAttribute('role', 'status');
    const stageHint = node('p', 'Next-message selection is unavailable on this host. No responder is staged.', 'sbu-responder-hint');
    compact.append(pickerLabel, picker, compactActions, requestStatus, stageHint);

    const rulesPanel = node('details', undefined, 'sbu-reply-rules');
    rulesPanel.id = 'sbu-reply-rules';
    rulesPanel.append(node('summary', 'Reply Rules'));
    const body = node('div', undefined, 'sbu-reply-rules-body');
    const gate = node('p', capabilities.reason, 'sbu-responder-hint');
    gate.id = 'sbu-routing-gate';
    const routingStatus = node('p', '', 'sbu-responder-status');
    routingStatus.id = 'sbu-routing-status';
    routingStatus.setAttribute('role', 'status');
    const automatic = button('Automatic routing unavailable', () => {
        const result = controller.setAutomaticRouting(!controller.getRoutingState().automatic);
        actionFeedback = result?.ok === false ? result.reason : '';
        refresh();
    }, 'sbu-routing-enable');
    automatic.disabled = true;
    automatic.setAttribute('aria-describedby', gate.id);
    const conflict = node('p', '', 'sbu-responder-hint');
    const configWarning = node('p', '', 'sbu-responder-hint');
    const general = node('fieldset');
    general.append(node('legend', 'Reply Rules'));
    const fields = new Map();
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const rawRules = () => settings.get().reply_rules;
    function updateRules(patch) {
        const raw = rawRules();
        if (raw != null && !record(raw)) return false;
        settings.update({ reply_rules: { ...(raw ?? {}), ...patch } });
        return true;
    }
    function field(key, label, type, options) {
        const row = node('label', undefined, 'sbu-rule-field');
        row.htmlFor = `sbu-rule-${key}`;
        const input = node(options ? 'select' : 'input');
        input.id = `sbu-rule-${key}`;
        if (options) for (const [value, text] of options) {
            const option = node('option', text); option.value = value; input.append(option);
        }
        else input.type = type;
        if (type === 'number') { input.min = '0'; input.max = '20'; input.step = '1'; }
        input.addEventListener('change', () => updateRules({ [key]: type === 'checkbox' ? input.checked
            : type === 'number' ? Number(input.value) : input.value }));
        row.append(node('span', label), input);
        general.append(row);
        fields.set(key, input);
    }
    field('enabled', 'Enable Reply Rules (automatic routing is a separate choice)', 'checkbox');
    field('focusEnabled', 'Enable session focus for this conversation', 'checkbox');
    field('multiSpeaker', 'Select multiple addressed members', 'checkbox');
    field('mentionOrder', 'Select in order of first mention', 'checkbox');
    field('maxParticipants', 'Maximum participants per turn', 'number');
    field('maxResponses', 'Maximum replies per turn', 'number');
    field('perCharacterLimit', 'Maximum replies per character', 'number');
    field('fallback', 'Fallback', 'select', [['none', 'No automatic reply'], ['first-eligible', 'First eligible member in group order']]);
    const focusStatus = node('p', '', 'sbu-responder-status');
    focusStatus.setAttribute('role', 'status');
    const focusButton = button('Focus selected card', () => controller.setFocus([selectedAvatar]), 'sbu-rule-focus');
    const clearFocus = button('Clear focus', () => controller.clearFocus(), 'sbu-rule-clear-focus');
    const focusActions = node('div', undefined, 'sbu-responder-actions');
    focusActions.append(focusButton, clearFocus);
    const editLabel = node('label', 'Character card to configure');
    editLabel.htmlFor = 'sbu-rule-character';
    const cardPicker = node('select');
    cardPicker.id = 'sbu-rule-character';
    const cardEnabledLabel = node('label', undefined, 'sbu-rule-field');
    const cardEnabled = node('input');
    cardEnabled.type = 'checkbox'; cardEnabled.id = 'sbu-rule-card-enabled';
    cardEnabledLabel.htmlFor = cardEnabled.id;
    cardEnabledLabel.append(node('span', 'Eligible for local Reply Rules'), cardEnabled);
    function updateCard(patch) {
        if (!selected()) return;
        const raw = rawRules();
        const cards = raw?.characters;
        if (cards != null && !record(cards)) return;
        const card = cards && Object.hasOwn(cards, selectedAvatar) ? cards[selectedAvatar] : {};
        if (!record(card)) return;
        updateRules({ characters: { ...cards, [selectedAvatar]: { ...card, ...patch } } });
    }
    cardEnabled.addEventListener('change', () => updateCard({ enabled: cardEnabled.checked }));
    const phrases = node('div', undefined, 'sbu-rule-phrases');
    const testLabel = node('label', 'Text to preview');
    testLabel.htmlFor = 'sbu-rule-preview-text';
    const testText = node('textarea');
    testText.id = 'sbu-rule-preview-text'; testText.rows = 3;
    const useDraft = button('Copy draft to preview', () => { testText.value = composer.value; renderPreview(); });
    const preview = node('ul', undefined, 'sbu-rule-preview');
    preview.id = 'sbu-rule-preview';
    const previewSummary = node('p', '', 'sbu-responder-status');
    previewSummary.setAttribute('role', 'status');
    const hint = node('p', 'Rules match literal words and phrases, including mentions in discussion; they do not understand intent. Each phrase is a separate entry and may contain commas. Names shared by cards need unique aliases. Rules apply to these exact cards across groups. Focus lasts only in this open conversation; it is not saved.', 'sbu-responder-hint');
    body.append(gate, automatic, routingStatus, conflict, configWarning, general, hint, editLabel, cardPicker, cardEnabledLabel,
        phrases, focusStatus, focusActions, testLabel, testText, useDraft, previewSummary, preview);
    rulesPanel.append(body);

    function phraseList(label, values, save, key) {
        const group = node('fieldset');
        group.append(node('legend', label));
        values.forEach((value, index) => {
            const row = node('div', undefined, 'sbu-rule-phrase');
            const input = node('input');
            input.type = 'text'; input.value = value;
            input.setAttribute('aria-label', `${label} ${index + 1}`);
            input.addEventListener('change', () => save(values.map((item, i) => i === index ? input.value : item)));
            const remove = button('Remove', () => save(values.filter((_, i) => i !== index)));
            remove.setAttribute('aria-label', `Remove ${label.toLowerCase()} ${index + 1}`);
            row.append(input, remove); group.append(row);
        });
        const add = button(`Add ${label.toLowerCase()}`, () => {
            save([...values, '']);
            [...phrases.querySelectorAll(`[data-phrases="${key}"] input`)].at(-1)?.focus();
        });
        group.dataset.phrases = key;
        group.append(add);
        return group;
    }

    function renderPreview() {
        const decision = controller.preview(testText.value);
        preview.replaceChildren();
        for (const item of decision.decisions) preview.append(node('li', `${item.name} [${item.avatar}]: ${item.reason}${item.selected ? ' — selected' : ''}`));
        for (const warning of decision.warnings) preview.append(node('li', warning));
        previewSummary.textContent = `Preview only: ${decision.targets.length} selected. No replies will be sent.`;
    }

    function refresh() {
        if (destroyed) return;
        const key = host.activeConversation()?.key;
        const members = host.resolveMembers();
        if (shownKey !== key) { selectedAvatar = undefined; testText.value = ''; phraseSignature = undefined; actionFeedback = ''; }
        shownKey = key;
        selectedAvatar = members.some(member => member.avatar === selectedAvatar) ? selectedAvatar : members[0]?.avatar;
        const signature = JSON.stringify(members.map(member => [member.avatar, member.name, member.disabled]));
        if (signature !== memberSignature) {
            for (const select of [picker, cardPicker]) {
                select.replaceChildren();
                for (const member of members) {
                    const option = node('option', `${member.name} · ${member.avatar}${member.disabled ? ' · automatic replies off' : ''}`);
                    option.value = member.avatar; select.append(option);
                }
            }
            memberSignature = signature;
        }
        picker.value = cardPicker.value = selectedAvatar ?? '';
        picker.disabled = cardPicker.disabled = !members.length;
        compact.hidden = !settings.get().responder_picker || !key;
        const state = controller.getState();
        const routed = controller.getRoutingState?.() ?? { available: false, automatic: false, staged: [], busy: false };
        const capabilities = host.routingCapabilities();
        const supported = routed.available && capabilities.automatic && capabilities.staged;
        const allowed = selectedAvatar && controller.canAskToRespond(selectedAvatar, key);
        ask.disabled = !allowed?.allowed;
        ask.title = allowed?.reason ?? 'Open a group conversation.';
        ask.textContent = selected()?.disabled ? 'Ask now (automatic replies off)' : 'Ask now';
        write.disabled = !selectedAvatar || state.busy;
        clearRequest.disabled = !state.busy;
        requestStatus.textContent = actionFeedback || (state.pending.length ? `Pending: ${state.pending.join(', ')}. Use native Stop to stop generation.`
            : state.status || (!allowed?.allowed ? allowed?.reason ?? '' : ''));
        const raw = rawRules();
        const config = normalizeRuleConfig(raw);
        stage.disabled = !supported || !selectedAvatar || Boolean(selected()?.disabled) || state.busy;
        stage.title = supported ? 'Apply this choice to the next successfully saved user message.' : capabilities.reason;
        clearStage.hidden = !routed.staged.length;
        clearStage.disabled = !routed.staged.length;
        stageHint.textContent = !supported ? 'Next-message selection is unavailable on this host. No responder is staged.'
            : routed.staged.length ? `Next responder: ${routed.staged.join(', ')}. A failed send keeps this choice.`
                : 'No responder is staged. Choices apply once and clear when the conversation changes.';
        automatic.textContent = !supported ? 'Automatic routing unavailable'
            : routed.automatic ? 'Turn off automatic routing' : 'Enable automatic routing for this chat';
        automatic.disabled = !supported || (!routed.automatic && (!config.enabled || state.busy));
        automatic.setAttribute('aria-pressed', String(routed.automatic));
        gate.textContent = !supported ? capabilities.reason
            : 'Routing lasts for this open chat. Ask now, native strategy changes, or leaving the chat turn it off. Clear request cancels the turn and turns routing off.';
        routingStatus.textContent = actionFeedback || routed.status || '';
        general.disabled = raw != null && !record(raw);
        configWarning.textContent = general.disabled ? 'Saved rule configuration is not a supported object. It has been preserved; editing is unavailable.' : '';
        for (const [key, input] of fields) {
            if (input.type === 'checkbox') input.checked = config[key];
            else if (input.value !== String(config[key])) input.value = config[key];
        }
        const card = Object.hasOwn(config.characters, selectedAvatar) ? config.characters[selectedAvatar] : { enabled: true, aliases: [], exclusions: [] };
        const authoredCards = raw?.characters;
        const authoredCard = record(authoredCards) && Object.hasOwn(authoredCards, selectedAvatar) ? authoredCards[selectedAvatar] : {};
        const listSupported = value => value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string'));
        const cardSupported = (authoredCards == null || record(authoredCards)) && record(authoredCard)
            && listSupported(authoredCard.aliases) && listSupported(authoredCard.exclusions);
        const allSupported = listSupported(raw?.allPhrases);
        if (!cardSupported || !allSupported) configWarning.textContent = 'Some saved rule entries have an unsupported format. Those entries are preserved and cannot be edited here.';
        const aliases = cardSupported ? authoredCard.aliases ?? [] : [];
        const exclusions = cardSupported ? authoredCard.exclusions ?? [] : [];
        const allPhrases = allSupported ? raw?.allPhrases ?? config.allPhrases : [];
        cardEnabled.checked = card.enabled !== false;
        cardEnabled.disabled = !selectedAvatar || general.disabled || !cardSupported;
        const nextPhrases = JSON.stringify([selectedAvatar, aliases, exclusions, allPhrases, general.disabled, cardSupported, allSupported]);
        if (nextPhrases !== phraseSignature) {
            phrases.replaceChildren();
            if (selectedAvatar) {
                phrases.append(phraseList('Alias or trigger phrase', aliases, values => updateCard({ aliases: values }), 'aliases'),
                    phraseList('Exclusion phrase', exclusions, values => updateCard({ exclusions: values }), 'exclusions'));
            }
            phrases.append(phraseList('All-eligible phrase', allPhrases, values => updateRules({ allPhrases: values }), 'all'));
            phrases.querySelectorAll('fieldset').forEach(fieldset => {
                fieldset.disabled = general.disabled || (fieldset.dataset.phrases === 'all' ? !allSupported : !cardSupported);
            });
            phraseSignature = nextPhrases;
        }
        focusStatus.textContent = state.focus.length ? `Session focus: ${state.focus.join(', ')}` : 'No conversation focus.';
        focusButton.disabled = !config.enabled || !config.focusEnabled || !selectedAvatar || selected()?.disabled || card.enabled === false;
        clearFocus.disabled = !state.focus.length;
        const signals = capabilities.competitors;
        conflict.textContent = signals.length ? `Possible competing automatic router settings: ${signals.join(', ')}. Nothing has been disabled. Our automatic routing stays inactive.` : '';
        renderPreview();
    }

    function changeSelection(event) { selectedAvatar = event.target.value; actionFeedback = ''; refresh(); }
    function keyboard(event) {
        if (event.key === 'Enter' && event.target.closest('button, input, select, textarea')) event.stopPropagation();
    }
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        for (const cleanup of cleanups.reverse()) cleanup();
        compact.remove(); rulesPanel.remove();
    };
    try {
        const nativeRow = document.getElementById('nonQRFormItems');
        if (nativeRow?.parentElement?.id === 'send_form' && nativeRow.contains(composer)) nativeRow.after(compact);
        else composer.before(compact);
        mount.append(rulesPanel);
        picker.addEventListener('change', changeSelection);
        cardPicker.addEventListener('change', changeSelection);
        testText.addEventListener('input', renderPreview);
        compact.addEventListener('keydown', keyboard);
        rulesPanel.addEventListener('keydown', keyboard);
        cleanups.push(settings.subscribe(refresh));
        cleanups.push(host.onContextChanged(refresh));
        cleanups.push(controller.subscribe(refresh));
        refresh();
    } catch (error) { destroy(); throw error; }
    return { refresh, destroy };
}
