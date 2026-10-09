export const extensionName = 'st-group-utils';

export const defaults = Object.freeze({
    char_position: 0,
    position: 1,
    depth: 4,
    include_wi: false,
    share_character_info: true,
    share_notes: true,
    bottom_bar_shortcut: false,
    current_members_shortcut: true,
    responder_picker: false,
    reply_rules: null,
    scene_controls: false,
    current_scenes: null,
    scene_suggestions: false,
    suggestion_profile: '',
    prose_styles: false,
    share_stopper: '.',
    max_share_length: 200,
    max_characters: -1,
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => isRecord(object) && Object.hasOwn(object, key);
const define = (object, key, value) => Object.defineProperty(object, key, {
    value, writable: true, enumerable: true, configurable: true,
});

/** Read compatibility defaults without changing settings or initiating a save. */
export function readSettings(extensionSettings) {
    const stored = own(extensionSettings, extensionName) && isRecord(extensionSettings[extensionName])
        ? extensionSettings[extensionName] : {};
    const settings = { ...defaults, ...stored };
    // Before this split, the description switch also controlled notes. Inherit it
    // only while there is no independent saved choice.
    if (!own(stored, 'share_notes')) settings.share_notes = settings.share_character_info;
    return settings;
}

/** Add missing defaults in place. Existing keys and all authored data survive. */
export function ensureSettings(extensionSettings) {
    if (!isRecord(extensionSettings)) throw new TypeError('Extension settings are unavailable');
    if (!own(extensionSettings, extensionName)) define(extensionSettings, extensionName, {});
    const stored = extensionSettings[extensionName];
    if (!isRecord(stored)) throw new TypeError('Group Utilities settings must be an object');
    const settings = readSettings(extensionSettings);
    for (const key of Object.keys(defaults)) {
        if (!own(stored, key)) define(stored, key, settings[key]);
    }
    return stored;
}

function identity(character, characters = []) {
    const list = Array.isArray(characters) ? characters : [];
    const avatar = character?.avatar;
    const editable = typeof avatar === 'string' && avatar.length > 0
        && list.filter(item => item?.avatar === avatar).length === 1;
    const uniqueName = typeof character?.name === 'string'
        && list.filter(item => item?.name === character.name).length === 1;
    return { editable, uniqueName };
}

const noteText = value => value == null ? '' : String(value);

/** Avatar notes take precedence; a blank avatar note explicitly suppresses fallback. */
export function getCharacterNote(settings, character, characters = []) {
    const { editable, uniqueName } = identity(character, characters);
    const legacyExists = typeof character?.name === 'string' && own(settings?.character_data, character.name);
    const ambiguousLegacy = legacyExists && !uniqueName;
    const result = { text: '', source: 'none', ambiguousLegacy, editable };
    // Expose ambiguous text only for an explicit, user-directed copy to a card.
    // It never becomes prompt context until such an assignment is saved.
    if (ambiguousLegacy) result.legacyText = noteText(settings.character_data[character.name]);
    if (!editable) return result;
    if (own(settings?.character_notes, character.avatar)) {
        return { ...result, text: noteText(settings.character_notes[character.avatar]), source: 'avatar' };
    }
    if (legacyExists && uniqueName) {
        return { ...result, text: noteText(settings.character_data[character.name]), source: 'legacy' };
    }
    return result;
}

/** Explicit edits create an avatar key; legacy name-keyed notes are never moved or deleted. */
export function setCharacterNote(settings, character, characters, text) {
    if (!isRecord(settings) || !identity(character, characters).editable) return false;
    if (!own(settings, 'character_notes')) define(settings, 'character_notes', Object.create(null));
    if (!isRecord(settings.character_notes)) return false;
    define(settings.character_notes, character.avatar, noteText(text));
    return true;
}
