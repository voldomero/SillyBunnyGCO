// Siblings load with this module's asset token, as groupUtils.js does, so a GCO update never mixes cached files.
const sibling = path => {
    const url = new URL(path, import.meta.url);
    const token = new URL(import.meta.url).searchParams.get('v') ?? globalThis.window?.SillyBunnyGroupUtilities?.assetToken;
    if (token) url.searchParams.set('v', token);
    return url.href;
};
const [
    { isOmniscient: omniscientIn, memoryOn, omniscientPatch },
    { HIDE_TYPES, blankItems, countHidden, planHidden },
    { timeOf: readTime },
    { createChatSaver },
    { createJoinTracker },
] = await Promise.all([
    import(sibling('./settings.js')),
    import(sibling('./scene-history.js')),
    import(sibling('./scene-roster.js')),
    import(sibling('./scene-saves.js')),
    import(sibling('./scene-joins.js')),
]);

const PREVIEW_LINES = 5;
const EXCERPT_LENGTH = 60;
const FILTER_FAILED = '[Group Utilities] Scene memory could not plan hidden lines; nothing is hidden.';
const PREVIEW_FAILED = '[Group Utilities] Scene memory could not count hidden lines for the preview.';

const isAvatar = value => typeof value === 'string' && value.length > 0;

// Counted in code points, so an emoji at the cut is kept whole.
const excerptOf = mes => typeof mes === 'string'
    ? Array.from(mes.replace(/\s+/g, ' ').trim()).slice(0, EXCERPT_LENGTH).join('') : '';

// A thrown value need not convert to a string (Object.create(null) cannot), and the filter must never throw.
function messageOf(error) {
    try {
        return String(error?.message || error) || 'unknown error';
    } catch {
        return 'unknown error';
    }
}

// host.timeOf rebuilds the whole host context for every line; reading the parser once keeps long chats cheap (§J.6).
const lineTimes = context => {
    const parse = context.timestampToMoment;
    return value => readTime(value, parse);
};

/** Scene memory for the open group chat: the prompt filter, preview counts and status. */
export function createSceneRecorder({ host, settings, scene, now = Date.now, log = console.warn }) {
    let destroyed = false;
    let lastError = null;
    const logged = new Set();
    const listeners = new Set();
    const saver = createChatSaver({ host, now, log });
    const joins = createJoinTracker({ host, settings, scene, saver, now, log });

    function notify() {
        for (const listener of [...listeners]) {
            try { listener(); } catch (error) { log('[Group Utilities] Scene memory view failed', error); }
        }
    }

    function logOnce(message, error) {
        if (logged.has(message)) return;
        logged.add(message);
        log(message, error);
    }

    function setLastError(value) {
        if (lastError === value) return;
        lastError = value;
        notify();
    }

    /** Why both hiding rules are off for this avatar, or null when they apply (§8, §J.6). */
    function skipReason(avatar) {
        if (destroyed || !isAvatar(avatar) || !host.activeConversation() || !memoryOn(settings.get())) return 'off';
        if (!host.ignoreSymbol()) return 'unavailable';
        if (host.historyCompetitor()) return 'vocalia';
        if (omniscientIn(settings.get(), avatar)) return 'omniscient';
        return null;
    }

    /** First step of the prompt interceptor: synchronous, never throws, and leaves the items untouched on error. */
    function filter(items, type, speaker) {
        try {
            if (!HIDE_TYPES.has(type) || skipReason(speaker)) return 0;
            // joinTime is undefined whenever the join check's gate fails, which turns off the join rule only.
            const plan = planHidden(items, { speaker, type, joinTime: joins.joinTime(speaker),
                timeOf: lineTimes(host.getContext()) });
            const hidden = blankItems(items, plan, host.ignoreSymbol());
            setLastError(null);
            return hidden;
        } catch (error) {
            logOnce(FILTER_FAILED, error);
            setLastError(messageOf(error));
            return 0;
        }
    }

    function hiddenFor(avatar) {
        const none = skipped => ({ away: 0, joined: 0, lines: [], skipped });
        try {
            const skipped = skipReason(avatar);
            if (skipped) return none(skipped);
            const context = host.getContext();
            const chat = context.chat;
            const counts = countHidden(chat, { speaker: avatar, joinTime: joins.joinTime(avatar),
                timeOf: lineTimes(context) });
            const lines = counts.lines.slice(-PREVIEW_LINES).reverse()
                .map(({ index, rule }) => ({ index, rule, excerpt: excerptOf(chat[index].mes) }));
            return { away: counts.away, joined: counts.joined, lines, skipped: null };
        } catch (error) {
            logOnce(PREVIEW_FAILED, error);
            return none('unavailable');
        }
    }

    function status() {
        const capable = host.memoryCapabilities();
        const config = settings.get();
        const history = capable.history && memoryOn(config);
        return {
            capable,
            history,
            automatic: history && capable.automatic && config.scene_auto === true,
            steppedAside: history && host.historyCompetitor(),
            lastError,
        };
    }

    function setOmniscient(avatar, on) {
        if (!isAvatar(avatar) || omniscientIn(settings.get(), avatar) === Boolean(on)) return;
        settings.update(omniscientPatch(settings.get(), avatar, Boolean(on)));
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        listeners.clear();
        joins.destroy();
        saver.destroy();
    }

    return {
        filter,
        hiddenFor,
        status,
        isOmniscient: avatar => omniscientIn(settings.get(), avatar),
        setOmniscient,
        subscribe(listener) {
            if (destroyed) return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        destroy,
    };
}
