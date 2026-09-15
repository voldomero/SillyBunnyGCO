const maximumResponseCharacters = 16384;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** Request transport only. The turn controller owns serialization, timeout, and cancellation. */
export function createSuggestionAdapter({ getContext = () => globalThis.SillyTavern?.getContext(), isGenerating } = {}) {
    function inspect(profileId) {
        const unavailable = reason => ({ allowed: false, reason });
        try {
            const context = getContext();
            const service = context?.ConnectionManagerRequestService;
            const registry = context?.extensionSettings;
            if (typeof service?.sendRequest !== 'function' || !Array.isArray(registry?.disabledExtensions)
                || !Array.isArray(registry?.connectionManager?.profiles)) return unavailable('The verified connection-profile request service is unavailable.');
            if (registry.disabledExtensions.some(name => String(name).replace(/^third-party\//i, '').toLowerCase() === 'connection-manager')) {
                return unavailable('Connection Manager is disabled.');
            }
            if (!nonempty(profileId)) return unavailable('Choose a direct OpenAI connection profile explicitly.');
            const matches = registry.connectionManager.profiles.filter(profile => profile?.id === profileId);
            if (matches.length !== 1) return unavailable('The selected connection profile is missing or ambiguous.');
            const profile = matches[0];
            const api = context.CONNECT_API_MAP?.[profile.api];
            if (api?.selected !== 'openai' || api.source !== 'openai' || !nonempty(profile.model)
                || !nonempty(profile['secret-id']) || (profile.proxy && profile.proxy !== 'None')) {
                return unavailable('Scene suggestions currently require a direct OpenAI profile with a saved model and credential selection.');
            }
            // The host exposes this predicate from /script.js, not getContext(). The host adapter verifies it.
            const generationState = typeof isGenerating === 'function' ? isGenerating() : undefined;
            if (typeof generationState !== 'boolean') return unavailable('Native generation state could not be verified.');
            if (generationState) return unavailable('Wait until native generation is idle.');
            return { allowed: true, reason: '', profile, fingerprint: JSON.stringify(profile), service,
                sendRequest: service.sendRequest };
        } catch { return unavailable('The selected connection profile could not be verified.'); }
    }

    function getProfiles() {
        try {
            const profiles = getContext()?.extensionSettings?.connectionManager?.profiles;
            if (!Array.isArray(profiles)) return [];
            return profiles.filter(profile => inspect(profile?.id).allowed)
                .map(profile => ({ id: profile.id, name: String(profile.name || profile.id), model: profile.model }));
        } catch { return []; }
    }

    function canRequest(profileId) {
        const { allowed, reason } = inspect(profileId);
        return { allowed, reason };
    }

    function matchesCapture(profileId, captured) {
        const current = inspect(profileId);
        return current.allowed && current.service === captured.service
            && current.sendRequest === captured.sendRequest && current.fingerprint === captured.fingerprint;
    }

    function captureProfile(profileId) {
        const captured = inspect(profileId);
        if (!captured.allowed) return undefined;
        return Object.freeze({ isCurrent: () => matchesCapture(profileId, captured) });
    }

    async function request({ profileId, messages, signal, maxTokens = 512 } = {}) {
        const reject = (status, reason) => ({ ok: false, status, reason });
        if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
            return reject('rejected', 'An owned cancellation signal is required.');
        }
        if (signal.aborted) return reject('invalidated', 'The suggestion request was cancelled.');
        if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 1024) return reject('rejected', 'Choose a response limit between 64 and 1024 tokens.');
        if (!Array.isArray(messages) || !messages.length || messages.length > 4
            || messages.some(message => !isRecord(message) || !['system', 'user'].includes(message.role)
                || typeof message.content !== 'string' || !message.content.trim())
            || messages.reduce((sum, message) => sum + message.content.length, 0) > 20000) {
            return reject('rejected', 'The explicit suggestion prompt is unavailable or too large.');
        }
        const captured = inspect(profileId);
        if (!captured.allowed) return reject('unavailable', captured.reason);
        const prompt = messages.map(({ role, content }) => ({ role, content }));
        const stillCurrent = () => !signal.aborted && matchesCapture(profileId, captured);
        try {
            // Skipping presets/instruct avoids prompt macros, global settings changes, and profile slash commands.
            const result = await captured.sendRequest.call(captured.service, profileId, prompt, maxTokens, {
                stream: false, extractData: true, includePreset: false, includeInstruct: false, signal,
            }, {
                max_tokens: maxTokens, n: 1, tools: [], tool_choice: 'none',
                enable_web_search: false, request_images: false, include_reasoning: false,
                custom_include_body: '', custom_exclude_body: '', custom_include_headers: '',
                custom_prompt_post_processing: '', reverse_proxy: '', proxy_password: '',
                cacheScope: 'auxiliary',
            });
            if (!stillCurrent()) return reject('invalidated', 'The suggestion request or connection profile is no longer current.');
            const text = result?.content;
            if (typeof text !== 'string' || !text.trim() || text.length > maximumResponseCharacters) {
                return reject('error', 'The suggestion response was empty, unsupported, or too large. No retry was made.');
            }
            return { ok: true, status: 'returned', text, reason: '' };
        } catch {
            if (!stillCurrent()) return reject('invalidated', 'The suggestion request or connection profile is no longer current.');
            return reject('error', 'The suggestion request failed. No retry was made.');
        }
    }

    return { getProfiles, canRequest, captureProfile, request };
}
