/** Coordinate manual requests, suggestions and the optional versioned host routing lease. */
export function createTurnController({ host, settings, decide, scene, suggestions, createRoutingController, timeoutMs = 120000,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    let disposed = false;
    let epoch = 0;
    let active;
    let focus = [];
    let conversationKey;
    let conversationChat;
    let status = '';
    let proposalBatch;
    const listeners = new Set();
    const cleanups = [];
    const notify = () => {
        for (const listener of listeners) {
            try { listener(); } catch (error) { console.warn('[Group Utilities] Responder view failed', error); }
        }
    };
    const rules = () => settings.get().reply_rules ?? {};
    const sceneAllows = avatar => scene?.canRespond(avatar, host.activeConversation()?.key).allowed !== false;
    const cardEligible = avatar => {
        const cards = rules().characters;
        return !cards || !Object.hasOwn(cards, avatar) || cards[avatar]?.enabled !== false;
    };
    const routing = createRoutingController?.({ host, settings, scene, decide,
        canStart: () => !disposed && !active, getFocus: () => [...focus], onChange: notify,
        timeoutMs, setTimer, clearTimer });
    const routingState = () => routing?.getState() ?? { automatic: false, staged: [], busy: false, pending: [], status: '' };

    function sync() {
        const key = host.activeConversation()?.key;
        const members = host.resolveMembers();
        const chat = host.getContext().chat;
        const changed = key !== conversationKey || chat !== conversationChat;
        if (changed) {
            conversationKey = key;
            conversationChat = chat;
            focus = [];
            status = '';
        }
        if (rules().enabled !== true || rules().focusEnabled !== true) focus = [];
        else focus = focus.filter(avatar => members.some(member => member.avatar === avatar && !member.disabled)
            && cardEligible(avatar) && sceneAllows(avatar));
        if (proposalBatch && !proposalBatch.current()) proposalBatch = undefined;
        if (active && !active.invalid && (changed || host.getContext().chat !== active.chat
            || (active.kind === 'suggestion' ? !active.current()
                : !members.some(member => member.avatar === active.avatar && member.character === active.character)
                    || !sceneAllows(active.avatar)))) {
            invalidate('The conversation or character changed. Request invalidated.');
        }
    }

    function invalidate(reason) {
        reason ??= active?.nativeCancellation
            ? 'Request cleared. Cancellation requested; reply completion is unverified.'
            : 'Request cleared. Use native Stop to stop any running response.';
        epoch++;
        proposalBatch = undefined;
        if (active) {
            active.invalid = true;
            active.abort?.abort();
            active.cancel({ ok: false, status: 'invalidated', reason });
        }
        if (active && active.key === host.activeConversation()?.key) status = reason;
        notify();
    }

    function canAskToRespond(avatar, key) {
        sync();
        if (disposed) return { allowed: false, reason: 'Responder controls are disabled.' };
        if (active || routingState().busy) return { allowed: false, reason: 'A reply or suggestion request is still outstanding.' };
        const scenePermission = scene?.canRespond(avatar, key);
        if (scenePermission?.allowed === false) return scenePermission;
        return host.canAskToRespond(avatar, key);
    }

    async function askToRespond(avatar, key) {
        const allowed = canAskToRespond(avatar, key);
        if (!allowed.allowed) return { ok: false, status: 'rejected', reason: allowed.reason };
        routing?.clearStage();
        routing?.setAutomatic(false);
        const current = host.getContext();
        const member = host.resolveMembers().find(item => item.avatar === avatar);
        const request = { avatar, character: member.character, key: host.activeConversation().key,
            chat: current.chat, origin: current.chat?.at(-1), epoch: ++epoch, invalid: false,
            abort: new AbortController(), nativeCancellation: current.generationSupportsRequestControls === true };
        const cancelled = new Promise(resolve => { request.cancel = resolve; });
        active = request;
        proposalBatch = undefined;
        status = `Requesting ${member.name}…`;
        notify();
        const timer = setTimer(() => {
            if (active === request && !request.invalid) invalidate(request.nativeCancellation
                ? 'Reply request timed out. Cancellation requested; completion is unknown. No retry was made.'
                : 'Reply request timed out. Completion is unknown; no retry was made. Use native Stop if needed.');
        }, timeoutMs);
        // Even after timeout/invalidation the lock lasts until the original host call settles.
        const execution = (async () => {
            try {
                // A view listener may clear or disable the request during the initial notification.
                if (request.abort.signal.aborted) return { ok: false, status: 'invalidated', reason: 'The request is no longer current.' };
                const result = await (request.nativeCancellation
                    ? host.askToRespond(avatar, request.key, { signal: request.abort.signal })
                    : host.askToRespond(avatar, request.key));
                sync();
                if (disposed || request.invalid || request.epoch !== epoch || conversationKey !== request.key) {
                    return { ok: false, status: 'invalidated', reason: 'The request is no longer current.' };
                }
                const reason = result === false ? 'The host did not accept this reply request.'
                    : 'Native request returned. Reply completion is unverified; no automatic follow-up or retry.';
                status = reason;
                return { ok: result !== false, status: result === false ? 'rejected' : 'returned', reason };
            } catch (error) {
                const reason = 'Reply request failed. Completion is unknown; no retry was made.';
                if (!disposed && !request.invalid && conversationKey === request.key) status = reason;
                return { ok: false, status: 'error', reason };
            } finally {
                clearTimer(timer);
                if (active === request) active = undefined;
                if (!disposed) notify();
            }
        })();
        return Promise.race([execution, cancelled]);
    }

    function canSuggest(profileId) {
        sync();
        if (disposed || settings.get().scene_suggestions !== true) return { allowed: false, reason: 'Scene suggestions are disabled.' };
        if (active || routingState().busy) return { allowed: false, reason: 'Wait for the outstanding reply or suggestion request.' };
        const snapshot = scene?.getSnapshot();
        if (!snapshot?.key || !snapshot.enabled || !snapshot.supported || !snapshot.participants.length) {
            return { allowed: false, reason: 'Enable current-scene controls in a group conversation first.' };
        }
        return suggestions?.adapter.canRequest(profileId) ?? { allowed: false, reason: 'The verified suggestion service is unavailable.' };
    }

    async function requestSceneSuggestions({ profileId, instruction }) {
        const permission = canSuggest(profileId);
        if (!permission.allowed) return { ok: false, reason: permission.reason };
        const snapshot = scene.getSnapshot();
        let messages;
        try { messages = suggestions.buildSceneSuggestionPrompt({ instruction, participants: snapshot.participants }); }
        catch (error) { return { ok: false, reason: error.message }; }
        const profile = suggestions.adapter.captureProfile(profileId);
        if (!profile) return { ok: false, reason: 'The selected connection profile is unavailable.' };
        const chat = host.getContext().chat;
        const members = host.resolveMembers();
        const signature = JSON.stringify(snapshot.participants);
        let history;
        try { history = JSON.stringify(chat); }
        catch { return { ok: false, reason: 'The conversation state could not be verified.' }; }
        const requestEpoch = ++epoch;
        const current = () => {
            try {
                const latest = scene.getSnapshot();
                const roster = host.resolveMembers();
                return !disposed && epoch === requestEpoch && settings.get().scene_suggestions === true
                    && settings.get().suggestion_profile === profileId && latest.enabled && latest.supported
                    && latest.key === snapshot.key && host.getContext().chat === chat
                    && JSON.stringify(chat) === history
                    && JSON.stringify(latest.participants) === signature && profile.isCurrent()
                    && roster.length === members.length && members.every(member => roster.some(item =>
                        item.avatar === member.avatar && item.character === member.character));
            } catch { return false; }
        };
        const request = { kind: 'suggestion', key: snapshot.key, chat, current, epoch: requestEpoch,
            invalid: false, abort: new AbortController() };
        const cancelled = new Promise(resolve => { request.cancel = resolve; });
        active = request;
        proposalBatch = undefined;
        status = 'Requesting scene suggestions…';
        notify();
        const timer = setTimer(() => {
            if (active === request && !request.invalid) invalidate('Scene suggestion timed out. No retry was made.');
        }, timeoutMs);
        const execution = (async () => {
            try {
                if (!current()) return { ok: false, reason: 'The scene suggestion is no longer current.' };
                const result = await suggestions.adapter.request({ profileId, messages, signal: request.abort.signal, maxTokens: 512 });
                sync();
                if (request.invalid || !current()) return { ok: false, reason: 'The scene suggestion is no longer current.' };
                const parsed = result.ok ? suggestions.parseSceneSuggestions(result.text, snapshot.participants) : result;
                if (!parsed.ok) { status = parsed.reason; return { ok: false, reason: status }; }
                proposalBatch = { current, key: snapshot.key, proposals: parsed.proposals.map(proposal => Object.freeze({ ...proposal })) };
                status = parsed.proposals.length ? 'Review a suggested change. Applying one clears the other suggestions.' : 'No scene changes suggested.';
                return { ok: true, reason: status };
            } catch {
                if (current()) status = 'Scene suggestion failed. No retry was made.';
                return { ok: false, reason: 'Scene suggestion failed. No retry was made.' };
            } finally {
                clearTimer(timer);
                // Cancellation may return early, but no next request starts before transport settlement.
                if (active === request) active = undefined;
                if (!disposed) notify();
            }
        })();
        return Promise.race([execution, cancelled]);
    }

    function applySceneSuggestion(proposal) {
        sync();
        if (active || routingState().busy || !proposalBatch?.current() || !proposalBatch.proposals.includes(proposal)) {
            return { ok: false, reason: 'This suggestion is no longer current. Request a fresh suggestion.' };
        }
        const valid = suggestions.validateSceneProposal(proposal, scene.getSnapshot().participants);
        if (!valid.ok) return valid;
        const key = proposalBatch.key;
        proposalBatch = undefined;
        const result = scene.setState(proposal.avatar, proposal.to, key);
        status = result.ok ? 'Suggested current-scene change applied. Earlier events are unchanged.' : result.reason;
        notify();
        return result;
    }

    function preview(text) {
        sync();
        const members = host.resolveMembers().map(member => {
            const permission = scene?.canRespond(member.avatar, conversationKey);
            return permission ? { ...member, sceneAllowed: permission.allowed, sceneReason: permission.reason } : member;
        });
        return decide({ text, members, config: rules(), focus });
    }

    function setFocus(avatars) {
        sync();
        if (disposed || !conversationKey || rules().enabled !== true || rules().focusEnabled !== true) return false;
        focus = [...new Set(avatars)].filter(avatar => host.resolveMembers().some(member => member.avatar === avatar
            && !member.disabled) && cardEligible(avatar) && sceneAllows(avatar));
        notify();
        return true;
    }

    function getState() {
        sync();
        const routed = routingState();
        return { key: conversationKey, focus: [...focus], busy: Boolean(active) || routed.busy,
            pending: active && active.key === conversationKey && !active.invalid && active.avatar ? [active.avatar] : routed.pending,
            status: active ? status : routed.status || status };
    }

    function destroy() {
        if (disposed) return;
        disposed = true;
        invalidate('Responder controls disabled.');
        routing?.destroy();
        focus = [];
        for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch (error) { console.warn('[Group Utilities] Responder cleanup failed', error); }
        }
        listeners.clear();
    }

    try {
        sync();
        cleanups.push(host.onTurnEvent(name => {
            if (['GENERATION_STOPPED', 'MESSAGE_SENT', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
                'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_DELETED'].includes(name)) {
                invalidate(name === 'GENERATION_STOPPED' ? 'Stopped.' : 'History changed. Request invalidated.');
            }
            if (['GENERATION_STARTED', 'MESSAGE_RECEIVED'].includes(name) && (active?.kind === 'suggestion' || proposalBatch)) {
                invalidate('Conversation activity changed. Scene suggestions cleared.');
            }
            sync();
            notify();
        }));
        cleanups.push(settings.subscribe(() => { sync(); notify(); }));
        if (scene) cleanups.push(scene.subscribe(() => { sync(); notify(); }));
    } catch (error) { destroy(); throw error; }
    return { askToRespond, canAskToRespond, preview, setFocus, getState, canSuggest,
        requestSceneSuggestions, applySceneSuggestion,
        getSceneSuggestions() { sync(); return [...(proposalBatch?.proposals ?? [])]; },
        clearSceneSuggestions() {
            if (active?.kind === 'suggestion') invalidate('Scene suggestion stopped.');
            else { proposalBatch = undefined; notify(); }
        },
        getRoutingState() { return { ...routingState(), available: Boolean(routing) }; },
        setAutomaticRouting(enabled) { return routing?.setAutomatic(enabled) ?? false; },
        stageResponder(avatar, key) { return routing?.stageResponder(avatar, key) ?? false; },
        clearStagedResponder() { routing?.clearStage(); },
        clearFocus() { focus = []; notify(); },
        clear(reason) { invalidate(reason); routing?.clear(reason); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, destroy };
}
