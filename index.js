const bundleState = window.SillyBunnyGroupUtilities ??= {};
// One token follows the whole extension graph for this page; the host revalidates the entry.
bundleState.assetToken ??= String(Date.now());
const bootstrapUrl = new URL('./src/assets.js', import.meta.url);
bootstrapUrl.searchParams.set('v', bundleState.assetToken);
const { createAssetUrl } = await import(bootstrapUrl.href);
export const assetUrl = createAssetUrl(import.meta.url, bundleState.assetToken);
const { initializeModule, createCleanupScope } = await import(assetUrl('./src/lifecycle.js'));
export const loadBundledModule = (name, loader) => initializeModule(bundleState, name, loader);

async function initializeMembersPanel() {
    const api = bundleState.groupUtilsApi;
    if (!api) throw new Error('Group Utilities context is unavailable');
    const scope = createCleanupScope();
    let rejectCancellation;
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    const cancel = () => {
        scope.dispose();
        rejectCancellation(new Error('Group Members initialization cancelled'));
    };
    bundleState.pendingModuleCleanups ??= new Set();
    bundleState.pendingModuleCleanups.add(cancel);
    try {
        await Promise.race([Promise.all(['./members-panel.css', './responder-controls.css'].map(path => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = assetUrl(path);
            scope.add(() => link.remove());
            return new Promise((resolve, reject) => {
                link.onload = resolve;
                link.onerror = () => reject(new Error('Group Members styles could not load'));
                document.head.append(link);
            });
        })), cancellation]);
        const [{ createMembersPanel }, { writeAsCharacter }, { createTurnController },
            { evaluateReplyRules, normalizeRuleConfig }, { createResponderControls }, { createSceneControls },
            { createSuggestionAdapter }, suggestionDecisions, { createSuggestionControls }, { createProseStyles }] = await Promise.race([Promise.all([
            import(assetUrl('./src/members-panel.js')),
            import(assetUrl('./groupSendAs.js')),
            import(assetUrl('./src/turn-controller.js')),
            import(assetUrl('./src/reply-rules.js')),
            import(assetUrl('./src/responder-controls.js')),
            import(assetUrl('./src/scene-controls.js')),
            import(assetUrl('./src/suggestion-adapter.js')),
            import(assetUrl('./src/scene-suggestions.js')),
            import(assetUrl('./src/suggestion-controls.js')),
            import(assetUrl('./src/prose-styles.js')),
        ]), cancellation]);
        if (scope.closed || bundleState.bundleDisabled) throw new Error('Group Members initialization cancelled');
        await Promise.race([api.host.prepareSuggestionSupport(), cancellation]);
        if (scope.closed || bundleState.bundleDisabled) throw new Error('Group Members initialization cancelled');
        const adapter = createSuggestionAdapter({ getContext: api.host.getContext, isGenerating: api.host.isGenerating });
        const controller = createTurnController({ ...api, decide: evaluateReplyRules, suggestions: { adapter, ...suggestionDecisions } });
        scope.add(() => controller.destroy());
        bundleState.turnController = controller;
        scope.add(() => { if (bundleState.turnController === controller) delete bundleState.turnController; });
        const writeAs = (character, chatKey) => {
            if (controller.getState().busy || api.host.activeConversation()?.key !== chatKey
                || !api.host.resolveMembers().some(member => member.avatar === character.avatar)) return false;
            return writeAsCharacter(character.avatar);
        };
        const panel = createMembersPanel({
            ...api,
            createSceneControls,
            host: { ...api.host, canAskToRespond: controller.canAskToRespond, canWriteAs: () => !controller.getState().busy },
            writeAs,
            askToRespond: (character, chatKey) => controller.askToRespond(character.avatar, chatKey),
        });
        scope.add(() => panel.destroy());
        scope.add(controller.subscribe(panel.refresh));
        const controls = createResponderControls({ ...api, controller, writeAs, normalizeRuleConfig });
        scope.add(() => controls.destroy());
        const suggestionControls = createSuggestionControls({ ...api, controller, adapter });
        scope.add(() => suggestionControls.destroy());
        const proseStyles = createProseStyles(api);
        scope.add(() => proseStyles.destroy());
        bundleState.membersPanel = panel;
        const settingsButton = document.getElementById('sbu-open-members');
        if (settingsButton) settingsButton.disabled = false;
        scope.add(() => {
            if (settingsButton) settingsButton.disabled = true;
            if (bundleState.membersPanel === panel) delete bundleState.membersPanel;
        });
        return () => scope.dispose();
    } catch (error) {
        scope.dispose();
        throw error;
    } finally {
        bundleState.pendingModuleCleanups.delete(cancel);
    }
}

export async function initializeBundle() {
    if (bundleState.loaderPromise) return bundleState.loaderPromise;
    const context = SillyTavern.getContext();
    const folder = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1));
    const ownExtension = name => name === `third-party/${folder}` || name === folder;
    bundleState.bundleDisabled = (context.extensionSettings.disabledExtensions ?? []).some(ownExtension);
    if (!bundleState.disableHandler && context.eventTypes.EXTENSION_DISABLED) {
        bundleState.disableHandler = name => {
            if (!ownExtension(name)) return;
            bundleState.bundleDisabled = true;
            for (const cancel of bundleState.pendingModuleCleanups ?? []) cancel();
            for (const cleanup of bundleState.moduleCleanups?.values() ?? []) {
                try { cleanup(); } catch (error) { console.warn('[Group Utilities] Cleanup failed', error); }
            }
            bundleState.moduleCleanups?.clear();
            bundleState.loadedModules?.clear();
            document.body.classList.remove('sbu-group-utilities-loaded');
        };
        context.eventSource.on(context.eventTypes.EXTENSION_DISABLED, bundleState.disableHandler);
    }
    bundleState.loaderPromise = (async () => {
        await loadBundledModule('group-greetings', () => import(assetUrl('./vendor/group-greetings/dist/index.js')));
        await loadBundledModule('group-utils', () => import(assetUrl('./groupUtils.js')));
        await loadBundledModule('group-send-as', () => import(assetUrl('./groupSendAs.js')));
        await loadBundledModule('current-members-popout', () => import(assetUrl('./src/current-members-popout.js')));
        await loadBundledModule('members-panel', async () => ({ initialize: initializeMembersPanel }));
        if (!bundleState.bundleDisabled) document.body.classList.add('sbu-group-utilities-loaded');
    })();
    try { await bundleState.loaderPromise; }
    finally { bundleState.loaderPromise = null; }
}

jQuery(() => {
    void initializeBundle().catch(error => console.error('[SillyBunny Group Utilities] Bundle initialization failed', error));
});
