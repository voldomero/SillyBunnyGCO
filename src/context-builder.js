// This boundary deliberately has no module imports or host side effects. The
// caller supplies versioned dependencies and owns prompt publication/cancellation.
const copyCharacter = character => character ? {
    avatar: character.avatar,
    name: String(character.name ?? ''),
    description: typeof character.description === 'string' ? character.description : '',
    personality: typeof character.personality === 'string' ? character.personality : '',
} : undefined;

const replaceCharacter = (text, character) => String(text)
    .replaceAll('{{char}}', () => character.name).replaceAll(':', ',');

async function limitedDescription(text, character, settings, countTokens) {
    const stopper = settings.share_stopper;
    let candidate = stopper ? text.split(String(stopper))[0] : text;
    candidate = replaceCharacter(candidate, character).trim();
    if (!candidate) return '';
    const configured = Number(settings.max_share_length);
    const maximum = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 200;
    if (maximum === 0) return '';
    if (typeof countTokens !== 'function') throw new Error('Tokenizer unavailable');
    const count = async value => {
        const tokens = Number(await countTokens(value));
        if (!Number.isFinite(tokens) || tokens < 0) throw new Error('Tokenizer returned an invalid count');
        return tokens;
    };
    // A stopper does not bypass the budget. Count the full prefix: summing
    // individual word counts is not equivalent for the host's tokenizers.
    if (await count(candidate) <= maximum) return candidate;
    let truncated = '';
    for (const word of candidate.split(/\s+/u)) {
        const next = truncated ? `${truncated} ${word}` : word;
        if (await count(next) > maximum) break;
        truncated = next;
    }
    const punctuation = Math.max(...['.', ',', ';', '?'].map(mark => truncated.lastIndexOf(mark)));
    if (punctuation > -1) {
        const sentence = truncated.slice(0, punctuation + 1).replace(/[,;?]$/u, '.');
        if (await count(sentence) <= maximum) return sentence;
    }
    return truncated;
}

/**
 * Build exactly the extension context shown by preview. All mutable input data
 * is captured before the first await; this function never saves or sets prompts.
 */
export async function buildContext({
    snapshot = {}, settings = {}, countTokens, getNote,
    nativeDescriptionContext = {}, heightAssistance,
} = {}) {
    const capturedSettings = { ...settings };
    const currentScene = snapshot.scene?.enabled && snapshot.scene?.supported && Array.isArray(snapshot.scene.participants) ? snapshot.scene.participants
        .filter(member => ['present', 'absent', 'remote'].includes(member.status))
        .map(member => ({ avatar: member.avatar, name: String(member.name ?? ''), status: member.status })) : [];
    const members = (Array.isArray(snapshot.members) ? snapshot.members : []).filter(Boolean).map(copyCharacter);
    const speaker = copyCharacter(snapshot.speaker);
    const nativeKnown = nativeDescriptionContext.known === true;
    const included = new Set(Array.isArray(nativeDescriptionContext.includedAvatars)
        ? nativeDescriptionContext.includedAvatars : []);
    const descriptions = [];
    const notes = [];
    let heights = [];
    const omissions = [];
    const warnings = new Set();
    const shareDescriptions = capturedSettings.share_character_info ?? true;
    const shareNotes = capturedSettings.share_notes ?? shareDescriptions;
    const omit = (character, kind, reason) => omissions.push({ avatar: character.avatar, name: character.name, kind, reason });

    // Resolve every note now so a later edit cannot leak into an in-flight build.
    if (shareNotes) {
        if (typeof getNote !== 'function') warnings.add('Character notes are unavailable.');
        else for (const character of members) {
            try {
                const note = getNote(settings, character, snapshot.characters);
                if (note?.text) notes.push({ avatar: character.avatar, name: character.name,
                    text: replaceCharacter(note.text, character), source: note.source });
                else if (note?.ambiguousLegacy) omit(character, 'note', 'Legacy name is ambiguous; assign a note to this card.');
            } catch {
                omit(character, 'note', 'Note unavailable.');
                warnings.add('Some character notes could not be prepared.');
            }
        }
    }

    if (shareDescriptions) {
        if (!nativeKnown) warnings.add('Native description context is unknown; descriptions may overlap with the host.');
        const configured = Number(capturedSettings.max_characters);
        const maximum = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : Infinity;
        for (const character of members) {
            if (speaker?.avatar && character.avatar === speaker.avatar) {
                omit(character, 'description', 'The speaker is supplied by the host.');
                continue;
            }
            if (nativeKnown && included.has(character.avatar)) {
                omit(character, 'description', 'Already supplied by the host.');
                continue;
            }
            if (!character.description.trim()) {
                omit(character, 'description', 'No description.');
                continue;
            }
            if (descriptions.length >= maximum) {
                omit(character, 'description', 'Description limit reached.');
                continue;
            }
            try {
                const content = await limitedDescription(character.description, character, capturedSettings, countTokens);
                if (content) descriptions.push({ avatar: character.avatar, name: character.name, text: `[System Note: ${content}]` });
                else omit(character, 'description', 'No description fits the configured limits.');
            } catch {
                omit(character, 'description', 'Description token count unavailable.');
                warnings.add('Some descriptions could not be prepared; notes remain available.');
            }
        }
        // Height comparisons retain the existing description-sharing switch, but
        // do not disappear just because native group generation supplies cards.
        if (typeof heightAssistance === 'function') {
            try {
                const generated = await heightAssistance({ generatingCharacter: speaker, members });
                if (!Array.isArray(generated)) throw new Error('Invalid height context');
                heights = generated.filter(text => typeof text === 'string' && text.length > 0);
            } catch {
                warnings.add('Height assistance is unavailable; other context remains available.');
            }
        }
    }

    const sceneText = currentScene.length ? ['Current scene only; this does not establish who witnessed earlier events.',
        ...currentScene.map(member => `${member.name} [${member.avatar}]: ${member.status === 'remote' ? 'remotely connected, not physically present' : member.status}.`)].join('\n') : '';
    return {
        text: [...descriptions.map(item => item.text), ...notes.map(item => item.text), ...heights, ...(sceneText ? [sceneText] : [])].join('\n'),
        scene: currentScene,
        descriptions, notes, heights, omissions, warnings: [...warnings],
    };
}
