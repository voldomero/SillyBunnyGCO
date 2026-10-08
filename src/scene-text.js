// Every scene memory string by ID. {tokens} mark where the panel puts a name, a status or a number (see textParts).
export const SCENE_TEXT = Object.freeze({
    P1: 'Scene memory',
    P1h: 'Each new message records who was absent. When a member replies, messages they missed and messages from before they joined are hidden from them.',
    P2: 'Automatic presence',
    P2h: 'Marks members present or absent from simple English lines in your messages and replies, such as "Alice walks in." or "Bob heads out." Needs scene memory.',
    P3: 'Knows everything',
    P4: 'Scene memory is on.',
    P4off: 'Scene memory is off.',
    P5: 'Latest automatic changes',
    P6: '{name}: {from} → {to}',
    P6present: 'present',
    P6absent: 'absent',
    P6remote: 'remotely connected',
    P6unspecified: 'unspecified',
    P7: 'Waits until replies finish',
    P8: 'Undo',
    P9: 'No automatic changes.',
    P10: 'Messages hidden because {name} was absent: {n}',
    P10line: 'Hidden message',
    P11: 'Automatic presence updated the current scene.',
    P12: 'Undo',
    P13: 'This chat had no saved scene. Members absent at its newest message were marked absent.',
    P14: "Vocalia's history filter is on, so Vocalia handles hiding.",
    P15: 'Some scene memory notes in this chat could not be read and are ignored.',
    P16: 'Scene memory is unavailable in this SillyBunny version.',
    P17: 'Scene memory is on. Automatic presence is unavailable in this SillyBunny version.',
    P18: 'Hiding failed, so the last prompt was sent with nothing hidden.',
    P19: 'Undone.',
    P20: 'Could not complete this action. The chat or scene has changed.',
    P21: 'Joined after message {last}. Earlier messages hidden: {n}',
    P21none: 'No messages from before this member joined.',
    P22: 'Joined mid-chat. Scene memory does not hide earlier messages from this member.',
    P23: 'Show earlier messages (cannot be undone)',
    P24: 'Messages from before they joined are no longer hidden.',
    P25: 'Earlier messages hidden from new members:',
    P26: 'Messages hidden because {name} joined later: {n}',
    P27: "This chat's join list could not be read and was reset. Current members count as there from the start.",
    P28: "This chat's join list is from a newer GCO version. Earlier messages are not hidden from members who joined later.",
    R1: 'Current state is saved for this conversation. Unspecified members have no scene restriction. Mute, membership and native routing stay separate. Nothing is hidden from members unless scene memory is on.',
});

/**
 * Splits a template on its `{token}` marks, putting each token's part in its place so callers can keep their own
 * nodes (a styled count, a name) inside the sentence. Tokens without a part are left out.
 */
export function textParts(template, parts) {
    if (typeof template !== 'string') return [];
    return template.split(/(\{\w+\})/).flatMap(piece => {
        const token = /^\{(\w+)\}$/.exec(piece)?.[1];
        if (token === undefined) return piece ? [piece] : [];
        return Object.hasOwn(parts, token) ? [parts[token]] : [];
    });
}
