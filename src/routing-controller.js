/** Session-only routing. The host lease owns selection, sends, persistence and generation. */
export function createRoutingController({ host, settings, scene, decide, canStart = () => true,
    getFocus = () => [], onChange = () => {}, timeoutMs = 120000,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    let disposed = false;
    let automatic = false;
    let staged;
    let stageRevision = 0;
    let leaseRecord;
    let active;
    let status = '';
    let syncing = false;
    let notifying = false;
    const cleanups = [];
    const rules = () => settings.get().reply_rules ?? {};
    const notify = () => {
        if (disposed || notifying) return;
        notifying = true;
        try { onChange(); } catch (error) { console.warn('[Group Utilities] Routing view failed', error); }
        finally { notifying = false; }
    };
    const failure = reason => ({ ok: false, reason });
    const sceneSignature = () => {
        const value = scene?.getSnapshot();
        return JSON.stringify(value && { key: value.key, enabled: value.enabled,
            supported: value.supported, participants: value.participants });
    };
    const eligible = (member, key) => member && !member.disabled
        && (!Object.hasOwn(rules().characters ?? {}, member.avatar) || rules().characters[member.avatar]?.enabled !== false)
        && scene?.canRespond(member.avatar, key).allowed !== false;

    function availability(kind) {
        const capabilities = host.routingCapabilities();
        if (capabilities?.competitors?.length) return failure('Another automatic router is enabled.');
        if (capabilities?.[kind] !== true) return failure(capabilities?.reason || 'Verified host routing is unavailable.');
        const api = host.getContext().groupTurnRouting;
        if (api?.version !== 1 || typeof api.acquire !== 'function') return failure('Verified host routing is unavailable.');
        const conversation = host.activeConversation();
        if (!conversation?.key || conversation.groupId == null || conversation.chatId == null) {
            return failure('Open a group conversation first.');
        }
        return { ok: true, api, conversation };
    }

    function sameScope(record) {
        const conversation = host.activeConversation();
        return conversation?.key === record.key && conversation.groupId === record.groupId
            && conversation.chatId === record.chatId && host.getContext().chat === record.chat
            && conversation.group?.activation_strategy === record.strategy;
    }

    function cancelActive(reason) {
        if (!active || active.invalid) return;
        active.invalid = true;
        status = reason;
        try { active.record.lease?.cancel(reason); }
        catch (error) { console.warn('[Group Utilities] Owned turn cancellation failed', error); }
    }

    function release(record, reason) {
        if (!record || record.released) return;
        record.released = true;
        if (leaseRecord === record) leaseRecord = undefined;
        try { record.lease?.release(reason); }
        catch (error) { console.warn('[Group Utilities] Routing lease release failed', error); }
    }

    function clear(reason = 'Routing cleared.') {
        automatic = false;
        staged = undefined;
        stageRevision++;
        cancelActive(reason);
        release(leaseRecord, reason);
        status = reason;
        notify();
    }

    function sync() {
        if (disposed || syncing) return;
        syncing = true;
        try {
            if (leaseRecord) {
                const record = leaseRecord;
                const available = availability(automatic ? 'automatic' : 'staged');
                if (!available.ok || available.api !== record.api || !sameScope(record) || !record.lease?.isCurrent()) {
                    clear(available.ok ? 'Host routing ownership or conversation changed.' : available.reason);
                    return;
                }
            }
            if (automatic && rules().enabled !== true) {
                clear('Automatic Reply Rules were disabled.');
                return;
            }
            if (staged) {
                const matches = host.resolveMembers().filter(member => member.avatar === staged.avatar);
                if (matches.length !== 1 || matches[0].character !== staged.character
                    || !eligible(matches[0], staged.key)) {
                    staged = undefined;
                    stageRevision++;
                    cancelActive('The staged character is no longer eligible.');
                    if (!automatic) release(leaseRecord, 'Staged character cleared.');
                    status = 'The staged character is no longer eligible.';
                    notify();
                }
            }
            if (active && !active.invalid && active.current && !active.current()) {
                cancelActive('Routing inputs changed. The remaining replies were cancelled.');
                notify();
            }
        } catch {
            clear('Routing state could not be verified.');
        } finally { syncing = false; }
    }

    function plan(record, input) {
        const request = active;
        if (!request || request.record !== record || request.invalid || record !== leaseRecord
            || input.requestId !== request.requestId || input.turnId !== request.turnId
            || input.groupId !== record.groupId || input.chatId !== record.chatId || input.chat !== record.chat) return null;
        try {
            if (disposed || !canStart() || !sameScope(record) || !record.lease.isCurrent() || (!automatic && !staged)) return null;
            const roster = host.resolveMembers().map(member => ({ ...member }));
            const members = roster.map(member => {
                const permission = scene?.canRespond(member.avatar, record.key);
                return permission ? { ...member, sceneAllowed: permission.allowed, sceneReason: permission.reason } : member;
            });
            const rawRules = rules();
            const ruleSignature = JSON.stringify(rawRules);
            const capturedScene = sceneSignature();
            const focus = getFocus();
            const focusSignature = JSON.stringify(focus);
            const choice = staged;
            const capturedStage = stageRevision;
            const selection = decide({ text: input.text, members,
                config: choice ? { ...rawRules, enabled: true } : rawRules,
                explicit: choice ? [choice.avatar] : [], focus });
            const avatars = selection?.targets;
            if (!Array.isArray(avatars) || new Set(avatars).size !== avatars.length
                || avatars.some(avatar => typeof avatar !== 'string'
                    || roster.filter(member => member.avatar === avatar).length !== 1
                    || !eligible(roster.find(member => member.avatar === avatar), record.key))) return null;
            request.pending = [...avatars];
            request.stage = choice;
            request.stageRevision = capturedStage;
            request.current = () => {
                try {
                    if (disposed || active !== request || request.invalid || record !== leaseRecord || record.released
                        || !record.lease.isCurrent() || !sameScope(record) || !canStart()) return false;
                    const available = availability(choice ? 'staged' : 'automatic');
                    if (!available.ok || available.api !== record.api || JSON.stringify(rules()) !== ruleSignature
                        || sceneSignature() !== capturedScene || JSON.stringify(getFocus()) !== focusSignature) return false;
                    if (choice ? !request.acknowledged && (staged !== choice || stageRevision !== capturedStage)
                        : !automatic || rules().enabled !== true) return false;
                    const latest = host.resolveMembers();
                    return latest.length === roster.length && roster.every((member, index) => {
                        const other = latest[index];
                        return other?.avatar === member.avatar && other.character === member.character
                            && other.name === member.name && other.disabled === member.disabled;
                    });
                } catch { return false; }
            };
            if (!request.current()) return null;
            notify();
            return { avatars: [...avatars], isCurrent: request.current };
        } catch { return null; }
    }

    function receive(record, event) {
        if (!event || record.released && active?.record !== record) return;
        if (event.type === 'revoked') {
            if (record === leaseRecord) {
                automatic = false;
                staged = undefined;
                stageRevision++;
                leaseRecord = undefined;
                record.released = true;
                if (active?.record === record) active.invalid = true;
                status = event.reason || 'Host routing ownership was revoked.';
                notify();
            }
            return;
        }
        if (event.type === 'turn-started') {
            if (record !== leaseRecord || active || event.requestId == null || event.turnId == null) return;
            const request = { record, requestId: event.requestId, turnId: event.turnId,
                pending: [], acknowledged: false, invalid: false };
            active = request;
            request.timer = setTimer(() => {
                if (active !== request || request.invalid) return;
                cancelActive('Routing timed out. Cancellation requested; no retry was made.');
                notify();
            }, timeoutMs);
            status = 'Preparing the submitted turn…';
            if (disposed || !canStart() || !sameScope(record)) cancelActive('The submitted turn is no longer current.');
            notify();
            return;
        }
        const request = active;
        if (!request || request.record !== record || event.requestId !== request.requestId || event.turnId !== request.turnId) return;
        if (event.type === 'finished') {
            clearTimer(request.timer);
            active = undefined;
            if (!request.invalid && sameScope(record)) {
                status = event.reason || (event.status === 'success' ? 'The routed turn finished.' : 'The routed turn ended without retrying.');
            }
            if (!automatic && !staged) release(record, 'No further routed turn is armed.');
            notify();
            return;
        }
        if (request.invalid) return;
        if (event.type === 'acknowledged' && request.current && !request.acknowledged) {
            request.acknowledged = true;
            if (request.stage && staged === request.stage && stageRevision === request.stageRevision) {
                staged = undefined;
                stageRevision++;
            }
            status = 'User message saved. Waiting for the selected replies…';
        } else if (event.type === 'reply-started' && request.acknowledged && event.avatar === request.pending[0]) {
            request.reply = event.avatar;
            status = `Requesting ${host.resolveMembers().find(member => member.avatar === event.avatar)?.name ?? 'selected character'}…`;
        } else if (event.type === 'reply-completed' && request.reply === event.avatar
            && event.avatar === request.pending[0] && event.status === 'success') {
            request.pending.shift();
            request.reply = undefined;
        } else return;
        notify();
    }

    function acquire(kind) {
        if (leaseRecord) return { ok: true };
        const available = availability(kind);
        if (!available.ok) return available;
        const { api, conversation } = available;
        const record = { api, key: conversation.key, groupId: conversation.groupId, chatId: conversation.chatId,
            chat: host.getContext().chat, strategy: conversation.group?.activation_strategy, released: false };
        try {
            const lease = api.acquire({ ownerId: 'sillybunny-group-chat-overhaul',
                groupId: record.groupId, chatId: record.chatId,
                plan: input => plan(record, input), onEvent: event => receive(record, event) });
            record.lease = lease;
            if (!lease || typeof lease.isCurrent !== 'function' || typeof lease.release !== 'function'
                || typeof lease.cancel !== 'function' || !lease.isCurrent()) {
                lease?.release?.('The routing lease contract is unavailable.');
                return failure('The host could not grant routing ownership.');
            }
            leaseRecord = record;
            return { ok: true };
        } catch {
            release(record, 'The routing lease contract could not be verified.');
            return failure('The host could not grant routing ownership.');
        }
    }

    function setAutomatic(enabled) {
        sync();
        if (disposed) return failure('Routing controls are disabled.');
        if (typeof enabled !== 'boolean') return failure('Choose whether automatic Reply Rules are enabled.');
        if (!enabled) {
            automatic = false;
            cancelActive('Automatic Reply Rules were turned off.');
            if (!staged) release(leaseRecord, 'Automatic Reply Rules were turned off.');
            notify();
            return { ok: true, reason: '' };
        }
        if (active || !canStart()) return failure('Wait for the outstanding reply or suggestion request.');
        if (rules().enabled !== true) return failure('Enable Reply Rules before automatic replies.');
        const permission = availability('automatic');
        if (!permission.ok) return permission;
        const result = acquire('automatic');
        if (!result.ok) return result;
        automatic = true;
        status = 'Automatic Reply Rules are armed for this conversation.';
        notify();
        return { ok: true, reason: '' };
    }

    function stageResponder(avatar, key) {
        sync();
        if (disposed) return failure('Routing controls are disabled.');
        if (active || !canStart()) return failure('Wait for the outstanding reply or suggestion request.');
        const permission = availability('staged');
        if (!permission.ok) return permission;
        if (key !== undefined && key !== permission.conversation.key) return failure('The active conversation has changed.');
        const matches = host.resolveMembers().filter(member => member.avatar === avatar);
        if (matches.length !== 1 || !eligible(matches[0], permission.conversation.key)) return failure('This exact character is not eligible to respond.');
        const result = acquire('staged');
        if (!result.ok) return result;
        staged = { avatar, character: matches[0].character, key: permission.conversation.key };
        stageRevision++;
        status = `${matches[0].name} is selected for the next submitted message.`;
        notify();
        return { ok: true, reason: '' };
    }

    function clearStage() {
        staged = undefined;
        stageRevision++;
        if (active?.stage) cancelActive('The staged responder was cleared.');
        if (!automatic) release(leaseRecord, 'The staged responder was cleared.');
        notify();
    }

    function destroy() {
        if (disposed) return;
        disposed = true;
        clear('Routing controls disabled.');
        if (active) clearTimer(active.timer);
        for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch (error) { console.warn('[Group Utilities] Routing cleanup failed', error); }
        }
    }

    try {
        cleanups.push(host.onTurnEvent(name => {
            if (['GENERATION_STOPPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED',
                'MESSAGE_SWIPED', 'CHAT_DELETED'].includes(name)) cancelActive('The turn was stopped or its history changed.');
            // Ordinary message events cannot acknowledge a send or advance a reply queue.
            sync();
            notify();
        }));
        cleanups.push(settings.subscribe(() => { sync(); notify(); }));
        if (scene) cleanups.push(scene.subscribe(() => { sync(); notify(); }));
    } catch (error) { destroy(); throw error; }
    return { getState() { sync(); return { automatic, staged: staged ? [staged.avatar] : [], busy: Boolean(active),
        pending: active && !active.invalid ? [...active.pending] : [], status }; },
    sync, setAutomatic, stageResponder, clearStage, clear, destroy };
}
