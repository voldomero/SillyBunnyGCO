let activeCleanup;

export function initialize() {
    if (activeCleanup) return activeCleanup;
    const records = new Map();
    let observer;

    function enhance(popout) {
        if (records.has(popout)) return;
        const bar = popout.querySelector('.panelControlBar');
        const contents = popout.querySelector('#currentGroupMembers');
        const close = popout.querySelector('#groupMemberListPopoutClose');
        if (!bar || !contents || !close) return;

        const frame = document.createElement('div');
        frame.className = 'sbu-current-members-frame';
        const title = document.createElement('h2');
        title.className = 'sbu-current-members-title';
        title.textContent = document.querySelector('#groupCurrentMemberListToggle [data-i18n="Current Members"]')?.textContent.trim() || 'Current Members';
        const attributes = new Map(['role', 'tabindex', 'aria-label'].map(name => [name, close.getAttribute(name)]));
        const children = [...close.childNodes];
        const onKeyDown = event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) close.click();
        };
        // Keep the native close node and grip ID so their existing handlers survive.
        popout.insertBefore(frame, bar);
        frame.append(bar, contents);
        bar.prepend(title);
        close.textContent = 'Close';
        close.setAttribute('role', 'button');
        close.setAttribute('tabindex', '0');
        close.setAttribute('aria-label', `Close ${title.textContent}`);
        close.addEventListener('keydown', onKeyDown);
        popout.classList.add('sbu-current-members-popout');
        records.set(popout, () => {
            close.removeEventListener('keydown', onKeyDown);
            close.replaceChildren(...children);
            for (const [name, value] of attributes) {
                if (value === null) close.removeAttribute(name);
                else close.setAttribute(name, value);
            }
            title.remove();
            frame.replaceWith(...frame.childNodes);
            popout.classList.remove('sbu-current-members-popout');
        });
    }

    function refresh() {
        for (const [popout, restore] of records) {
            if (popout.isConnected) continue;
            restore();
            records.delete(popout);
        }
        document.querySelectorAll('#groupMemberListPopout').forEach(enhance);
    }

    const cleanup = () => {
        observer?.disconnect();
        for (const restore of records.values()) restore();
        records.clear();
        if (activeCleanup === cleanup) activeCleanup = undefined;
    };
    try {
        refresh();
        observer = new MutationObserver(changes => {
            if (changes.some(change => change.target instanceof Element && change.target.closest('#groupMemberListPopout')
                || [...change.addedNodes, ...change.removedNodes].some(node => node instanceof Element
                    && (node.matches('#groupMemberListPopout') || node.querySelector('#groupMemberListPopout'))))) refresh();
        });
        observer.observe(document.getElementById('movingDivs') ?? document.body, { childList: true, subtree: true });
        activeCleanup = cleanup;
        return cleanup;
    } catch (error) {
        cleanup();
        throw error;
    }
}
