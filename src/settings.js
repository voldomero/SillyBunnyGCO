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
    scene_history: false,
    scene_auto: false,
    scene_omniscient: null,
    scene_history_since: null,
    scene_history_founders: null,
    scene_join_reveals: null,
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

const maxFounders = 2000;
const maxRevealPairs = 500;
const isAvatar = value => typeof value === 'string' && value.length > 0;
const isGroupId = value => (typeof value === 'string' && value.length > 0) || Number.isFinite(value);

function uniqueAvatars(values, limit = Infinity) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        if (result.length >= limit) break;
        if (!isAvatar(value) || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

/** Scene memory switched on through both settings, whether or not a token exists. */
export function memoryOn(settings) {
    return settings?.scene_controls === true && settings?.scene_history === true;
}

/** Scene memory on with a turn-on token; a missing token counts as off. */
export function memoryActive(settings) {
    return memoryOn(settings) && isAvatar(settings.scene_history_since);
}

/** Each group's deduplicated raw members at turn-on, keyed by `String(id)`. */
export function foundersSnapshot(groups, since) {
    const byGroup = {};
    for (const group of Array.isArray(groups) ? groups : []) {
        if (!isRecord(group) || !isGroupId(group.id) || !Array.isArray(group.members)) continue;
        const key = String(group.id);
        // The host resolves a group id to its first match, so a duplicate id keeps the first entry.
        if (Object.hasOwn(byGroup, key)) continue;
        define(byGroup, key, uniqueAvatars(group.members, maxFounders));
    }
    return { since, groups: byGroup };
}

function mintToken(now, groups) {
    const since = new Date(now).toISOString();
    return { scene_history_since: since, scene_history_founders: foundersSnapshot(groups, since) };
}

const clearedToken = () => ({ scene_history_since: null, scene_history_founders: null });

/** Copy of a settings patch, plus a new or cleared token when it turns scene memory on or off. */
export function withMemoryToken(before, patch, { now, groups } = {}) {
    const next = isRecord(patch) ? { ...patch } : {};
    const wasOn = memoryOn(before);
    const willBeOn = memoryOn({ ...before, ...next });
    if (!wasOn && willBeOn) return { ...next, ...mintToken(now, groups) };
    if (wasOn && !willBeOn) return { ...next, ...clearedToken() };
    return next;
}

/** Patch for settings changed outside the facade (per-tab recovery, SETTINGS_UPDATED), or null. */
export function alignMemoryToken(settings, { now, groups } = {}) {
    if (memoryOn(settings)) return memoryActive(settings) ? null : mintToken(now, groups);
    if (settings?.scene_history_since != null || settings?.scene_history_founders != null) return clearedToken();
    return null;
}

function omniscientAvatars(settings) {
    const flags = settings?.scene_omniscient;
    return isRecord(flags) ? Object.keys(flags).filter(avatar => flags[avatar] === true) : [];
}

function omniscientObject(avatars) {
    if (!avatars.length) return null;
    const flags = {};
    for (const avatar of avatars) define(flags, avatar, true);
    return flags;
}

export function isOmniscient(settings, avatar) {
    return isAvatar(avatar) && own(settings?.scene_omniscient, avatar) && settings.scene_omniscient[avatar] === true;
}

/** A new `scene_omniscient` value with the avatar's flag set or removed; null when none remain. */
export function omniscientPatch(settings, avatar, on) {
    const avatars = omniscientAvatars(settings).filter(entry => entry !== avatar);
    if (on && isAvatar(avatar)) avatars.push(avatar);
    return { scene_omniscient: omniscientObject(avatars) };
}

/** Pending `[chatKey, avatar]` reveal pairs, oldest first, newest 500 kept. */
export function readRevealPairs(settings) {
    const stored = Array.isArray(settings?.scene_join_reveals) ? settings.scene_join_reveals : [];
    return stored
        .filter(pair => Array.isArray(pair) && pair.length === 2 && isAvatar(pair[0]) && isAvatar(pair[1]))
        .slice(-maxRevealPairs)
        .map(([chatKey, avatar]) => [chatKey, avatar]);
}

function renameFounders(founders, from, to) {
    if (!isRecord(founders) || !isRecord(founders.groups)) return null;
    let changed = false;
    const byGroup = {};
    for (const [key, members] of Object.entries(founders.groups)) {
        if (Array.isArray(members) && members.includes(from)) {
            changed = true;
            define(byGroup, key, uniqueAvatars(members.map(avatar => avatar === from ? to : avatar)));
        } else {
            define(byGroup, key, members);
        }
    }
    return changed ? { ...founders, groups: byGroup } : null;
}

function renameRevealPairs(settings, from, to) {
    const pairs = readRevealPairs(settings);
    if (!pairs.some(([, avatar]) => avatar === from)) return null;
    const seen = new Set();
    const result = [];
    for (const [chatKey, avatar] of pairs) {
        const pair = [chatKey, avatar === from ? to : avatar];
        const id = JSON.stringify(pair);
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(pair);
    }
    return result;
}

/** CHARACTER_RENAMED: move the omniscience flag, founders and reveal pairs to the new avatar. */
export function renameMemorySettings(settings, from, to) {
    if (!isAvatar(from) || !isAvatar(to) || from === to) return null;
    const patch = {};
    if (isOmniscient(settings, from)) {
        const avatars = omniscientAvatars(settings).filter(avatar => avatar !== from && avatar !== to);
        patch.scene_omniscient = omniscientObject([...avatars, to]);
    }
    const founders = renameFounders(settings?.scene_history_founders, from, to);
    if (founders) patch.scene_history_founders = founders;
    const reveals = renameRevealPairs(settings, from, to);
    if (reveals) patch.scene_join_reveals = reveals;
    return Object.keys(patch).length ? patch : null;
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
