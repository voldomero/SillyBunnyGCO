const buttonSelector = '[data-sbu-send-as]';
const iconSelector = '#group_member_template .group_member_icon, #rm_group_members .group_member_icon';
let activeCleanup;

export function quoteCharacterReference(reference, strictEscaping = false) {
    // STscript consumes quote escapes in both modes, but pipe escapes only in legacy mode.
    let value = String(reference).replace(/(\\*)"/g, (_, slashes) => `${strictEscaping ? slashes.repeat(2) : slashes}\\"`);
    if (!strictEscaping) value = value.replace(/\|/g, '\\|');
    value = value.replace(/[{}]/g, '\\$&');
    return `"${value}"`;
}

export function prepareSendAsDraft(value, reference, selectionStart, selectionEnd, strictEscaping = false) {
    const oldPrefix = value.slice(0, sendAsPrefixLength(value, strictEscaping));
    const prefix = `/sendas name=${quoteCharacterReference(reference, strictEscaping)} `;
    const position = offset => prefix.length + Math.max(0, offset - oldPrefix.length);
    return {
        value: prefix + value.slice(oldPrefix.length),
        selectionStart: position(selectionStart),
        selectionEnd: position(selectionEnd),
    };
}

function sendAsPrefixLength(value, strictEscaping) {
    const command = value.match(/^\/sendas\s+name=/i)?.[0];
    if (!command) return 0;
    let end = command.length;
    if (value[end] === '"') {
        let slashes = 0;
        let closed = false;
        for (end += 1; end < value.length; end++) {
            const character = value[end];
            const escaped = strictEscaping ? slashes % 2 !== 0 : slashes > 0;
            if (character === '"' && !escaped) {
                end++;
                closed = true;
                break;
            }
            slashes = character === '\\' ? slashes + 1 : 0;
        }
        if (!closed) return 0;
    } else {
        const argument = value.slice(end).match(/^[^\s|]+/)?.[0];
        if (!argument) return 0;
        end += argument.length;
    }
    if (end === value.length) return end;
    return /[ \t]/.test(value[end]) ? end + 1 : 0;
}

export function getMemberReference(member, context) {
    if (!member || !Array.isArray(context?.characters)) return null;
    const avatar = globalThis.jQuery?.(member).data('id') ?? member.getAttribute('data-id');
    if (typeof avatar === 'string' && avatar) {
        const matches = context.characters.filter(character => character.avatar === avatar);
        return matches.length === 1 ? avatar : null;
    }
    const id = member.getAttribute('data-chid');
    if (id === null || !/^\d+$/.test(id)) return null;
    return context.characters[Number(id)]?.avatar || null;
}

export function hostResolvesReference(reference, context) {
    const characters = context.characters;
    const current = context.groupId
        ? context.groups?.find(group => group.id === context.groupId)?.members?.map(avatar => characters.find(character => character.avatar === avatar))
        : characters.filter(character => character.avatar === characters[context.characterId]?.avatar);
    if (!current || current.some(character => !character)) return false;
    const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    // The host prefers current-chat name matches before its exact-avatar lookup.
    const preferred = current.find(character => character.avatar === reference || normalize(character.name) === normalize(reference));
    return !preferred || preferred.avatar === reference;
}

function addSendAsButtons() {
    for (const icon of document.querySelectorAll(iconSelector)) {
        if (icon.querySelector(buttonSelector)) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.title = 'Write as a character';
        button.setAttribute('aria-label', 'Write as a character');
        button.setAttribute('data-sbu-send-as', '');
        button.classList.add('send_as', 'sbu-member-button', 'right_menu_button', 'fa-solid', 'fa-quote-right');
        icon.prepend(button);
    }
}

function onSendAsButtonClick(event) {
    const button = event.target instanceof Element ? event.target.closest(buttonSelector) : null;
    if (!button || !button.closest('#rm_group_members')) return;
    const context = globalThis.SillyTavern?.getContext();
    const reference = getMemberReference(button.closest('.group_member'), context);
    if (!reference) return;
    event.preventDefault();
    event.stopPropagation();
    writeAsCharacter(reference);
}

export function writeAsCharacter(reference) {
    if (globalThis.window?.SillyBunnyGroupUtilities?.turnController?.getState().busy) return false;
    const context = globalThis.SillyTavern?.getContext();
    const textArea = document.getElementById('send_textarea');
    if (!(textArea instanceof HTMLTextAreaElement)) return false;
    if (context?.characters?.filter(character => character.avatar === reference).length !== 1) return false;
    if (!hostResolvesReference(reference, context)) {
        globalThis.toastr?.warning('Multiple characters found for given conditions.');
        return false;
    }
    const direction = textArea.selectionDirection;
    const scrollTop = textArea.scrollTop;
    const scrollLeft = textArea.scrollLeft;
    const draft = prepareSendAsDraft(textArea.value, reference, textArea.selectionStart, textArea.selectionEnd,
        Boolean(context.powerUserSettings?.stscript?.parser?.flags?.[1]));
    if (draft.value !== textArea.value) {
        textArea.value = draft.value;
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    textArea.focus({ preventScroll: true });
    textArea.setSelectionRange(draft.selectionStart, draft.selectionEnd, direction);
    textArea.scrollTop = scrollTop;
    textArea.scrollLeft = scrollLeft;
    return true;
}

function onSendAsKeyDown(event) {
    if (event.key === 'Enter' && event.target instanceof Element
        && event.target.closest('#rm_group_members [data-sbu-send-as]')) {
        // The host's div-button fallback clicks on keydown without cancelling the default.
        event.stopPropagation();
    }
}

export async function initialize() {
    if (activeCleanup) return activeCleanup;
    let observer;
    const cleanup = () => {
        observer?.disconnect();
        document.removeEventListener('click', onSendAsButtonClick);
        document.removeEventListener('keydown', onSendAsKeyDown, true);
        document.querySelectorAll(buttonSelector).forEach(button => button.remove());
        if (activeCleanup === cleanup) activeCleanup = undefined;
    };
    try {
        addSendAsButtons();
        document.addEventListener('click', onSendAsButtonClick);
        document.addEventListener('keydown', onSendAsKeyDown, true);
        observer = new MutationObserver(records => {
            if (records.some(record => [...record.addedNodes].some(node => node instanceof Element
                && (node.matches('.group_member, .group_member_icon, #rm_group_members, #group_member_template')
                    || node.querySelector('.group_member, .group_member_icon'))))) {
                addSendAsButtons();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        activeCleanup = cleanup;
        return cleanup;
    } catch (error) {
        cleanup();
        throw error;
    }
}
