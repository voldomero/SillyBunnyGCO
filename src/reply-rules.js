// Pure selection only. The caller owns chat-scoped choices, persistence and replies.
export const ruleDefaults = Object.freeze({
    enabled: false,
    focusEnabled: false,
    multiSpeaker: false,
    mentionOrder: true,
    maxParticipants: 1,
    maxResponses: 1,
    perCharacterLimit: 1,
    fallback: 'none',
    allPhrases: Object.freeze(['everyone']),
    characters: Object.freeze({}),
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key);
const phraseText = value => typeof value === 'string' ? value.normalize('NFC').trim() : '';
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const samePhrase = (left, right) => new RegExp(`^${escapeRegex(left)}$`, 'iu').test(right);

function phrases(value) {
    const result = [];
    for (const entry of Array.isArray(value) ? value : []) {
        const phrase = phraseText(entry);
        if (phrase && !result.some(existing => samePhrase(existing, phrase))) result.push(phrase);
    }
    return result;
}

function limit(value, defaultValue) {
    if (typeof value !== 'number' && typeof value !== 'string') return defaultValue;
    if (typeof value === 'string' && !value.trim()) return defaultValue;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : defaultValue;
}

/** Read a normalized copy without migrating, saving or changing authored data. */
export function normalizeRuleConfig(raw) {
    const input = isRecord(raw) ? raw : {};
    const characters = {};
    for (const [avatar, value] of Object.entries(isRecord(input.characters) ? input.characters : {})) {
        const rule = isRecord(value) ? value : {};
        // Card filenames such as __proto__ remain ordinary exact keys.
        Object.defineProperty(characters, avatar, {
            value: { aliases: phrases(rule.aliases), exclusions: phrases(rule.exclusions), enabled: rule.enabled !== false },
            writable: true, configurable: true, enumerable: true,
        });
    }
    return {
        enabled: input.enabled === true,
        focusEnabled: input.focusEnabled === true,
        multiSpeaker: input.multiSpeaker === true,
        mentionOrder: input.mentionOrder !== false,
        maxParticipants: limit(input.maxParticipants, ruleDefaults.maxParticipants),
        maxResponses: limit(input.maxResponses, ruleDefaults.maxResponses),
        perCharacterLimit: limit(input.perCharacterLimit, ruleDefaults.perCharacterLimit),
        fallback: input.fallback === 'first-eligible' ? 'first-eligible' : 'none',
        allPhrases: phrases(own(input, 'allPhrases') ? input.allPhrases : ruleDefaults.allPhrases),
        characters,
    };
}

/**
 * Return the earliest UTF-16 offset in NFC-normalized text, or -1. Matching is
 * literal and case-insensitive; adjacent Unicode letters, numbers, marks and
 * underscores prevent a match. This does not infer who a sentence addresses.
 */
export function matchPhrase(text, phrase) {
    const needle = phraseText(phrase);
    if (!needle || typeof text !== 'string') return -1;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}_])${escapeRegex(needle)}(?![\\p{L}\\p{N}\\p{M}_])`, 'iu');
    const match = pattern.exec(text.normalize('NFC'));
    return match ? match.index + match[1].length : -1;
}

function firstMatch(text, entries) {
    let result = null;
    for (const phrase of entries) {
        const index = matchPhrase(text, phrase);
        if (index >= 0 && (!result || index < result.index)) result = { phrase, index };
    }
    return result;
}

/**
 * Select exact card identities and explain every roster entry. Explicit choices
 * and recognized rules keep priority even if safeguards reject every target:
 * an excluded or ambiguous request never silently chooses a fallback speaker.
 */
export function evaluateReplyRules({ text = '', members = [], config, explicit = [], focus = [] } = {}) {
    const settings = normalizeRuleConfig(config);
    const roster = Array.isArray(members) ? members : [];
    const warnings = new Set();
    const states = roster.map((member, order) => ({
        avatar: typeof member?.avatar === 'string' ? member.avatar : '',
        name: typeof member?.name === 'string' ? member.name : '',
        disabled: member?.disabled === true,
        sceneAllowed: member?.sceneAllowed !== false,
        sceneReason: member?.sceneReason,
        order, blocked: '', match: null, ambiguous: [],
    }));
    if (!settings.enabled) return {
        targets: [], source: 'disabled', warnings: [],
        decisions: states.map(({ avatar, name }) => ({ avatar, name, selected: false, reason: 'Reply Rules are disabled.' })),
    };

    const identityCounts = new Map();
    for (const state of states) identityCounts.set(state.avatar, (identityCounts.get(state.avatar) ?? 0) + 1);
    for (const state of states) {
        state.rule = own(settings.characters, state.avatar) ? settings.characters[state.avatar] : { aliases: [], exclusions: [], enabled: true };
        if (!state.avatar.trim()) {
            state.blocked = 'Card identity is unavailable.';
            warnings.add('Some members have no exact card identity and cannot be selected.');
        } else if (identityCounts.get(state.avatar) > 1) {
            state.blocked = 'Duplicate card identity; selection is unavailable.';
            warnings.add(`Duplicate card identity “${state.avatar}” cannot be selected.`);
        } else if (!state.sceneAllowed) state.blocked = state.sceneReason || 'The current scene excludes this member.';
        else if (state.disabled) state.blocked = 'Member is muted.';
        else if (!state.rule.enabled) state.blocked = 'Automatic-reply eligibility is disabled for this card.';
        else {
            const excluded = firstMatch(text, state.rule.exclusions);
            if (excluded) state.blocked = `Exclusion matched “${excluded.phrase}”.`;
        }
    }

    // Include muted/ineligible members when finding ambiguities: their presence
    // must not silently give another card ownership of a shared name or alias.
    const registry = [];
    for (const state of states) {
        for (const phrase of phrases([state.name, ...state.rule.aliases])) {
            let entry = registry.find(item => samePhrase(item.phrase, phrase));
            if (!entry) {
                entry = { phrase, owners: new Set() };
                registry.push(entry);
            }
            entry.owners.add(state.order);
        }
    }
    let recognizedRule = false;
    for (const entry of registry) {
        const index = matchPhrase(text, entry.phrase);
        if (entry.owners.size > 1) {
            warnings.add(`Ambiguous phrase “${entry.phrase}” belongs to multiple members; use a unique alias or an explicit card choice.`);
            if (index >= 0) {
                recognizedRule = true;
                for (const order of entry.owners) states[order].ambiguous.push(entry.phrase);
            }
            continue;
        }
        if (index < 0) continue;
        recognizedRule = true;
        const state = states[[...entry.owners][0]];
        if (!state.match || index < state.match.index) state.match = { index, reason: `Phrase matched “${entry.phrase}”.` };
    }
    const all = firstMatch(text, settings.allPhrases);
    if (all) {
        recognizedRule = true;
        for (const state of states) {
            if (!state.match || all.index < state.match.index) state.match = { index: all.index, reason: `All-eligible phrase matched “${all.phrase}”.` };
        }
    }

    const choices = entries => [...new Set((Array.isArray(entries) ? entries : []).filter(avatar => typeof avatar === 'string' && avatar.length > 0))];
    const explicitChoices = choices(explicit);
    const focusChoices = settings.focusEnabled ? choices(focus) : [];
    let source = 'none';
    let candidates = [];
    const selectionReasons = new Map();
    const fromIdentities = (identities, kind) => {
        const selected = [];
        for (const avatar of identities) {
            const state = states.find(item => item.avatar === avatar);
            if (!state) {
                warnings.add(`${kind} card “${avatar}” is no longer a member.`);
                continue;
            }
            selected.push(state);
            selectionReasons.set(state.order, `${kind} card choice.`);
        }
        return selected;
    };
    if (explicitChoices.length) {
        source = 'explicit';
        candidates = fromIdentities(explicitChoices, 'Explicit');
    } else if (recognizedRule) {
        source = 'rules';
        candidates = states.filter(state => state.match);
        if (settings.mentionOrder) candidates.sort((left, right) => left.match.index - right.match.index || left.order - right.order);
        for (const state of candidates) selectionReasons.set(state.order, state.match.reason);
    } else if (focusChoices.length) {
        source = 'focus';
        candidates = fromIdentities(focusChoices, 'Conversation focus');
    } else if (settings.fallback === 'first-eligible') {
        source = 'fallback';
        candidates = states.filter(state => !state.blocked).slice(0, 1);
        for (const state of candidates) selectionReasons.set(state.order, 'Configured first-eligible fallback.');
    }

    // Every selected card gets at most one reply in a deterministic decision.
    // Larger per-character allowances never manufacture duplicate targets.
    const maximum = settings.perCharacterLimit === 0 ? 0 : Math.min(
        settings.maxParticipants, settings.maxResponses, settings.multiSpeaker ? Infinity : 1,
    );
    const selectedStates = candidates.filter(state => !state.blocked).slice(0, maximum);
    const selectedOrders = new Set(selectedStates.map(state => state.order));
    const candidateOrders = new Set(candidates.map(state => state.order));
    const decisions = states.map(state => {
        const selected = selectedOrders.has(state.order);
        let reason = state.blocked;
        if (!reason && selected) reason = selectionReasons.get(state.order);
        else if (!reason && candidateOrders.has(state.order)) reason = 'Response limit reached.';
        else if (!reason && source === 'rules' && state.ambiguous.length) reason = `Ambiguous phrase “${state.ambiguous[0]}”; no card inferred.`;
        else if (!reason && source === 'explicit') reason = 'Another explicit card choice has priority.';
        else if (!reason && source === 'rules') reason = 'No unambiguous matching rule for this card.';
        else if (!reason && source === 'focus') reason = 'Card is outside the current conversation focus.';
        else if (!reason && source === 'fallback') reason = 'An earlier eligible member is the configured fallback.';
        else if (!reason) reason = 'No matching rule or enabled focus; fallback is no automatic reply.';
        return { avatar: state.avatar, name: state.name, selected, reason };
    });
    return { targets: selectedStates.map(state => state.avatar), decisions, source, warnings: [...warnings] };
}
