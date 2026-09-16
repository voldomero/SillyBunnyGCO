let activeCleanup;

export function initialize({ host, settings } = globalThis.SillyBunnyGroupUtilities?.groupUtilsApi ?? {}) {
    if (activeCleanup) return activeCleanup;
    const records = new Map();
    let observer;
    let shortcut;
    let unsubscribeSettings;
    let unsubscribeContext;
    let destroyed = false;
    let pending = false;
    let requestVersion = 0;

    function refreshShortcut() {
        if (!host || !settings || destroyed) return;
        if (!settings.get().current_members_shortcut) {
            requestVersion++;
            shortcut?.();
            shortcut = undefined;
            return;
        }
        shortcut ??= host.registerShortcut({
            id: 'sbu-current-members-shortcut', label: 'Current Members', icon: 'fa-address-book', onClick: toggle,
        });
        const availability = host.canOpenCurrentMembers();
        shortcut.element.disabled = pending || !availability.allowed;
        shortcut.element.title = availability.reason || 'Current Members';
        shortcut.element.setAttribute('aria-controls', 'groupMemberListPopout');
        shortcut.element.setAttribute('aria-expanded', String(host.isCurrentMembersOpen()));
    }

    async function toggle() {
        if (pending || destroyed) return;
        const version = ++requestVersion;
        pending = true;
        refreshShortcut();
        try {
            const result = await host.toggleCurrentMembers({ isCancelled: () => destroyed || version !== requestVersion });
            if (!destroyed && version === requestVersion && result?.ok === false && result.reason) globalThis.toastr?.warning(result.reason);
        } catch (error) {
            if (!destroyed && version === requestVersion) {
                console.warn('[Group Utilities] Current Members could not open', error);
                globalThis.toastr?.warning('Could not open Current Members. Try again or open it from the group editor.');
            }
        } finally {
            pending = false;
            refreshShortcut();
        }
    }

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
        refreshShortcut();
    }

    const cleanup = () => {
        destroyed = true;
        requestVersion++;
        observer?.disconnect();
        unsubscribeSettings?.();
        unsubscribeContext?.();
        shortcut?.();
        for (const restore of records.values()) restore();
        records.clear();
        if (activeCleanup === cleanup) activeCleanup = undefined;
    };
    try {
        refresh();
        observer = new MutationObserver(changes => {
            if (changes.some(change => change.attributeName === 'data-menu-type'
                || change.target instanceof Element && change.target.closest('#groupMemberListPopout')
                || [...change.addedNodes, ...change.removedNodes].some(node => node instanceof Element
                    && (node.matches('#groupMemberListPopout') || node.querySelector('#groupMemberListPopout'))))) refresh();
        });
        observer.observe(document.getElementById('movingDivs') ?? document.body, { childList: true, subtree: true });
        const editorPanel = document.getElementById('right-nav-panel');
        if (editorPanel) observer.observe(editorPanel, { attributes: true, attributeFilter: ['data-menu-type'] });
        if (host && settings) {
            unsubscribeSettings = settings.subscribe(refreshShortcut);
            unsubscribeContext = host.onContextChanged(refreshShortcut);
        }
        activeCleanup = cleanup;
        return cleanup;
    } catch (error) {
        cleanup();
        throw error;
    }
}
