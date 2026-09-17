# SillyBunny Group Chat Overhaul

**PRE-RELEASE v0.01**

SillyBunny Group Chat Overhaul (GCO) provides coordinated group-member controls, shared context, current-scene settings and optional assistance. Existing Group Utils settings and storage keys are retained to preserve your data.

This project exists to make group chats in [SillyBunny](https://github.com/platberlitz/SillyBunny) smoother by combining group-specific greetings, shared group context utilities, and quick `/sendas` support without requiring users to install and manage several separate extensions.

## Available in this pre-release

### Current scene and optional assistance

- **Group Dynamics → Current scene** now provides opt-in controls for present, absent and remotely connected members. Unspecified is the default. Choices belong to the exact card and conversation, and save through extension settings without writing the transcript.
- Scene restrictions apply to this extension's **Ask** actions, Reply Rules and focus. Membership and mute remain separate. When this extension does not own routing, the host can select replies independently.
- Optional **Scene suggestions** use an explicitly selected direct OpenAI connection profile. Each manual request may cost money. Suggestions require review and one explicit Apply action; they do not select speakers or run automatically.
- Optional prose styling uses the host's existing quote and emphasis markup. It leaves message text and code unchanged and requires no special model output.
- **Historical witnesses and knowledge/history filtering are unavailable.** Current scene choices do not establish who witnessed earlier events. Automatic turn suggestions are also unavailable.

### Responder controls and Reply Rules

- Stabilized native reply guards for mismatched group IDs, pending file attachments and replies returning after a conversation changes.
- Optional compact **Responder** controls share one request controller with Group Dynamics. **Write as** prepares a draft; **Ask now** requests one native reply with an empty composer. Clearing a request asks compatible hosts to cancel that request; native Stop remains available.
- **Reply Rules** provides exact-card aliases, separate phrase entries, exclusions, all-eligible addressing, mention order, response limits, session focus and an explanatory preview. It matches literal phrases, not meaning.
- **Choose next responder and automatic routing require compatible host support.** The controls stay disabled when that support is absent. Rule preview remains available and does not send replies or change native strategy.

### Group Dynamics

- **Group Dynamics** opens from the Extensions menu or Group Utils settings. An optional action-row shortcut uses the same open/close action. The panel starts closed and follows the active conversation. A separate **Current Members** shortcut opens SillyBunny's native member list.
- Select a member to edit their shared note, prepare a **Write as** draft, or **Ask to respond** through native group generation. Asking for a reply requires an empty composer so an existing draft is preserved.
- Notes and character descriptions have independent sharing switches. **Context preview** shows the extension's additions for a normal reply by the selected member, including omissions and any uncertainty about native description sharing.
- Existing notes and greetings are preserved. New note edits attach to the exact character card. Ambiguous older name-based notes remain available for explicit assignment to a card.
- Desktop placement and resizing use native Moving UI when enabled; **Reset position** resets only this panel's saved geometry. Narrow screens use a scrolling panel within the viewport.

## Bundled Extensions

This extension is based on and credits the following upstream projects:

- ~~[SillyTavern Presence](https://github.com/leandrojofre/SillyTavern-Presence) by [leandrojofre](https://github.com/leandrojofre).~~
- [Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings) by [Cohee](https://github.com/Cohee1207).
- [st-group-utils](https://github.com/DummyTBanana/st-group-utils) by [city-unit](https://github.com/city-unit).
- [SillyTavern GroupSendAs](https://github.com/SillyTavern/SillyTavern-GroupSendAs) by [Cohee](https://github.com/Cohee1207).

## Features

- Group-only greetings for character cards, with random or manual selection modes.
- Group utility prompts that can share character information and group notes during generation.
- A Group Dynamics panel for the active conversation, with shared notes and context preview.
- **Write as** prepares a `/sendas` draft using the host's character reference; **Ask to respond** requests a native generated reply.
- Optional current-scene controls, reviewed model-assisted scene suggestions, and styling for existing prose markup.
- Compact SillyBunny-specific current-member layout so Model Override and action buttons fit together more cleanly.

## Installation

Install through SillyBunny's built-in extension installer:

1. Open SillyBunny.
2. Go to **Extensions**.
3. Use the extension installer.
4. Paste `https://github.com/voldomero/SillyBunnyGCO`.
5. Disable any old Group Utilities copy, reload, then install and enable **SillyBunny Group Chat Overhaul**.
6. Restart or hard refresh SillyBunny after installation.

Keep only one active Group Utilities/GCO bundle and avoid duplicate standalone Greetings/Group Utilities/SendAs installations. Duplicate copies can register the same controls or generation interceptor more than once.

## Notes For SillyBunny

This is not a direct drop-in zip of the original extensions. It is a compatibility bundle with SillyBunny-specific changes:

- The bundled utilities load from one manifest and one extension entry.
- Member-row controls are coordinated so they do not fight SillyBunny's **Model Override** field.
- The legacy [SillyTavern-Presence](https://github.com/leandrojofre/SillyTavern-Presence) module is not included. Current-scene controls use extension settings; SillyBunny remains responsible for saving chat transcripts.
- Group utility notes are injected through SillyBunny's extension-prompt API instead of mutating the live generation chat array.
- Group utility settings, group greetings, and SendAs behavior remain available from the bundled extension.

## Usage

### Group Greetings

Open a character card or character creation form, then use the group greetings button near the first-message controls. You can add group-only greetings and choose whether SillyBunny picks one randomly or asks you to choose when starting a group chat.

### Group Utilities

Open **Group Dynamics** from the Extensions menu or Group Utils settings. The panel shows the active conversation even when a different group is open in the editor. Select a member to edit their note or open **Context preview**. Preview shows additional extension context, not the entire host prompt.

**Current Members** is SillyBunny's native list, with automatic-reply toggles, Model Override and member-management buttons. **Group Dynamics** contains shared notes, scene controls and context preview. Each window has its own shortcut.

The Current Members shortcut opens the active group's roster without switching chats. Finish or leave a new character or group form before using it.

Configure **Share group notes** and **Share character descriptions and height context** independently in Group Utils settings. **Show Group Dynamics in the action row** adds the optional Dynamics shortcut. **Show Current Members in the action row** is enabled by default and can be switched off separately. Both shortcuts appear beside Guided Impersonate and Flush Guides when that row is available, using the same native icon-button sizing. Group Dynamics stays closed until opened.

With native Moving UI enabled on desktop, use the grip to move the panel and its lower-right corner to resize it. **Reset position** restores its default placement. Native automatic-reply availability is shown as read-only information; it is not a record of who was historically present.

### Group SendAs

Use **Write as** in Group Dynamics, or the quote button in the native members list, to prepare a character's `/sendas` draft. Repeated use replaces the existing prefix and keeps the draft text and selection. Sending remains a separate action in the host composer.

**Ask to respond** requests a generated reply from the selected member. Finish or clear your draft first; this action is unavailable while the composer contains text or a response is running.

## Responder controls and Reply Rules

In **Group Utils**, enable **Show compact responder picker** to show controls near the composer. Choose a card by its name and filename; duplicate names remain separate. Muted cards stay visible. Asking a muted card explicitly requests a native manual reply; it does not enable automatic replies or change scene/knowledge state.

Ask requires an empty text draft and no pending file attachment or outstanding reply. Write as is also guarded while an extension reply request is outstanding. **Clear request** discards pending work and asks compatible hosts to cancel the owned request. On older hosts, use **Stop** to stop generation. An unresolved request keeps its lock even after a timeout or clear, until its native call returns. A returned manual call is not proof that a reply was produced; it never triggers an automatic follow-up or retry.

Open **Reply Rules** in settings and enable its local preview to configure:

- Exact-card aliases/trigger phrases and exclusions. Add each phrase in its own field; commas stay inside the phrase. Names and aliases use case-insensitive Unicode matching, with letter/number/mark/underscore boundaries and NFC normalization. A name embedded inside another word does not match. This does not infer whether someone is being addressed or discussed.
- Multiple addressed speakers and an all-eligible phrase (default `everyone`). Both obey mute/eligibility, exclusions and limits. Turn limits include participants, total replies and replies per character; zero permits none. Each selected card appears once, so a per-character limit above one does not create repeated replies.
- First-mention order or group order. Duplicate names or shared aliases are explained as ambiguous; use a unique alias to resolve them.
- Optional session focus using **Focus selected card**. It clears on disable, mute/ineligibility, unresolved membership or a conversation change. It is not saved or restored on reload.
- Fallback of **No automatic reply** (default), or the first eligible member. Selection priority is explicit choice, matching rules, focus, then fallback. An explicit or recognized request that is excluded/ambiguous does not unexpectedly fall through to another speaker.

Use **Text to preview**, or **Copy draft to preview**, to see decisions without changing or sending the composer. Rule configuration applies to exact cards across groups and saves through the existing settings path. Unresolved card settings remain stored; they are not reassigned by name. Settings suggesting a known competing automatic router produce an advisory warning. Other extensions are never disabled.

The preview and automatic selection use the same rules. When current-scene controls are enabled, explicitly absent cards are excluded from Ask actions, routing, preview and focus.

### Choosing the next responder

On compatible hosts, select a card and choose **Choose next responder**. This applies once, to the next successfully saved ordinary user message. **Clear next responder** removes the choice. A failed send keeps the choice for a later deliberate send; it does not retry automatically. Changing chats clears it. Write as, greetings, Continue, Regenerate and swipes do not trigger a routed turn. Using a native manual action or sending a slash command ends routing and clears its pending choice.

### Automatic routing

Enable Reply Rules, then choose **Enable automatic routing for this chat**. It starts off on reload and lasts only in the current open conversation. A staged responder takes precedence over matching rules, session focus and fallback. Speaker eligibility, exclusions and limits still apply.

While routing is enabled, the extension owns ordinary-turn selection. It does not rewrite the saved native strategy. Changing the native strategy, selecting a speaker in the native controls, using Ask now, or leaving the chat ends that ownership. **Clear request** cancels the turn and turns routing off. A detected competing router prevents activation. Each selected speaker runs in order only after the host acknowledges the submitted user message and each preceding reply. Stop, timeout, failed saves, changed conversation state or uncertain completion end the turn without retrying or advancing another reply.

Routed replies require tool calling to be off. They suppress automatic continuation and auto-swipe so those features cannot add replies beyond the configured limit. Manual native generation keeps its usual behavior.

These controls are unavailable when the host lacks the required support. Manual Ask now and rule preview continue to work there.

## Current scene

Open **Group Dynamics**, select a card, expand **Current scene**, and enable its controls. Each card starts **unspecified** until you choose a state:

| State | Meaning for this extension |
| --- | --- |
| Unspecified | No current-scene restriction is assigned. It is not evidence of presence. |
| Present | The card is marked as being in the current scene. |
| Absent | The card is excluded from this extension's Ask actions, Reply Rules preview and focus. |
| Remotely connected | The card is marked as connected to the scene and remains reachable by this extension. |

Use **Arrive**, **Depart**, **Connect remotely**, **Disconnect** or **Set absent** as appropriate. **Clear scene state** returns the selected card to unspecified. Turning the feature off removes its restrictions while keeping saved choices.

These controls do not add or remove group members, change mute settings, take over native routing, or alter what any character knows. A quiet member can still be present; selecting a speaker does not change scene state. The controls record current choices, not arrival/departure messages or historical witness events.

Choices save in extension settings under the exact conversation and character-card identity, not in the transcript. Duplicate names remain separate. State for missing or changed card identities is kept without reassignment by name. New chat identities, including new branches, start unspecified; state is not inferred or copied from their transcript. Existing history remains unknown for witness purposes. Unsupported saved scene formats are preserved and editing is gated.

### Historical witnesses and knowledge policy

Historical witness recording and knowledge/history filtering are **unavailable**. Current-scene choices do not establish what a character witnessed or restrict their access to earlier messages, World Info or other context.

## Optional scene suggestions

First enable current-scene controls in a group. In **Group Utils → Scene suggestions (optional)**, enable suggestions and explicitly choose a **direct OpenAI connection profile** with a saved model and credential selection. If the verified host request service or a supported profile is unavailable, requesting stays disabled. There is no automatic profile fallback.

Enter a description in **Describe the current scene**, then choose **Suggest scene changes**. Each request uses that connection and may cost money and take time. Along with fixed response-format instructions, it sends only the description you enter, exact card filenames, card names and current scene states. It does not include chat history, shared notes, character descriptions or the composer draft. The entered description and returned suggestions are not saved by this extension.

The response must contain at most three proposals, unique known cards, valid current-to-new states, and no unsupported fields. Invalid responses are rejected. Review each explanation; a model suggestion can be wrong. **Apply change for [card]** applies only that proposal and clears the entire batch. Request fresh suggestions to consider another change. Nothing is applied automatically.

Suggestions share the same outstanding-request lock as manual replies. **Stop / clear suggestions** requests cancellation and clears proposals. The lock remains until the underlying request settles, including after a timeout or cancellation. A changed chat, history, card identity, scene, connection profile, or disabled feature invalidates stale work; late results cannot apply to another conversation. Errors, timeouts and ambiguous outcomes do not trigger retries.

This feature suggests current-scene changes only. Automatic speaker/turn suggestions remain gated, and ordinary replies do not require a suggestion request.

## Optional prose styling

Enable **Style existing quotes and action emphasis in group chats** in Group Utils settings for slightly stronger quotes and a subtle theme-colored emphasis background. It applies only while a group conversation is active and restores native appearance when disabled.

Styling follows the host's existing `<q>` and `<em>` elements; it does not semantically identify dialogue or actions, parse structured replies, or rewrite message HTML or text. Code blocks and inline code are excluded. Ordinary prose remains usable with the feature off, and no model call or structured-response format is required.

## Credits

All credit for the original extension ideas and implementations belongs to their upstream authors and contributors:

- [Cohee](https://github.com/Cohee1207)
- ~~[leandrojofre](https://github.com/leandrojofre)~~
- [city-unit](https://github.com/city-unit)

This bundle adapts their work for a SillyBunny-focused workflow. Original repositories are linked in the **Bundled Extensions** section above.

## License

This bundle contains code from upstream projects containing licenses AGPL-3.0 and CC BY-SA.
