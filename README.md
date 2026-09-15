# SillyBunny Group Chat Overhaul

SillyBunny Group Chat Overhaul (GCO) continues SillyBunny Group Utilities with coordinated group-member controls, shared context, current-scene settings and optional assistance.

## IMPORTANT NOTICE: PRE-RELEASE 
This is a v0.01 testing build prepared for [voldomero/SillyBunnyGCO](https://github.com/voldomero/SillyBunnyGCO). **Please do not install**.

This project exists to make group chats in [SillyBunny](https://github.com/platberlitz/SillyBunny) smoother by combining group-specific greetings, shared group context utilities, and quick `/sendas` support without requiring users to install and manage several separate extensions.

## Updates

### Working checkout — Current scene and optional assistance (Milestones 2 and 4, unreleased)

- **Group Members → Current scene** now provides opt-in controls for present, absent and remotely connected members. Unspecified is the default. Choices belong to the exact card and conversation, and save through extension settings without writing the transcript.
- Scene restrictions apply to this extension's **Ask** actions, Reply Rules preview and focus. Membership, mute and native routing remain separate; native routing can still produce replies independently.
- Optional **Scene suggestions** use an explicitly selected direct OpenAI connection profile. Each manual request may cost money. Suggestions require review and one explicit Apply action; they do not select speakers or run automatically.
- Optional prose styling uses the host's existing quote and emphasis markup. It leaves message text and code unchanged and requires no special model output.
- **Historical witnesses and knowledge/history filtering remain gated.** Current scene choices do not establish who witnessed earlier events. Automatic turn suggestions and structured-response rendering are not implemented.

See the [Milestones 2–4 validation report](MILESTONE234-VALIDATION.md) for scope, results and remaining work, and the [Milestone 3 host-contract review](MILESTONE3-HOST-CONTRACT.md) for the missing history contracts. These changes are unreleased; manifest version remains **1.8**.

### Working checkout — Milestones 0–1 (unreleased)

- Stabilized native reply guards for mismatched group IDs, pending file attachments and replies returning after a conversation changes.
- Optional compact **Responder** controls share one request controller with Group Members. **Write as** prepares a draft; **Ask now** requests one native reply with an empty composer. Outstanding requests can be cleared; native Stop remains the way to stop generation.
- **Reply Rules** provides exact-card aliases, separate phrase entries, exclusions, all-eligible addressing, mention order, response limits, session focus and an explanatory preview. It matches literal phrases, not meaning.
- **Automatic routing and Choose next responder are unavailable on the inspected host.** Its selection, ownership, send acknowledgement and completion contracts do not safely support them. Rule preview does not send replies or change native strategy.

See [the earlier implementation plan](MILESTONE01-PLAN.md), [Milestones 0–1 validation report](MILESTONE01-VALIDATION.md), and [routing prerequisites](HOST-ROUTING-CONTRACT.md). The current-scene and optional-assistance additions above extend that initial scope.

The upload package is prepared in **Group Chat Overhaul** for the [SillyBunnyGCO repository](https://github.com/voldomero/SillyBunnyGCO). Read [compatibility and replacement-install guidance](COMPATIBILITY.md) before testing; keep only one active Group Utilities/GCO bundle. Earlier validation documents describe the source checkout and their original test runs.

The [live-host validation report](LIVE-HOST-VALIDATION.md) records testing against the installed host with disposable data, including Windows settings and transcript reloads. Run it explicitly with `SILLYBUNNY_LIVE_ROOT` set and `npm run test:live`; it does not use your normal profile.

### Working checkout — Phase 2 (unreleased)

- **Group Members** opens from the Extensions menu or Group Utils settings. An optional bottom-bar shortcut uses the same open/close action. The panel starts closed and follows the active conversation.
- Select a member to edit their shared note, prepare a **Write as** draft, or **Ask to respond** through native group generation. Asking for a reply requires an empty composer so an existing draft is preserved.
- Notes and character descriptions have independent sharing switches. **Context preview** shows the extension's additions for a normal reply by the selected member, including omissions and any uncertainty about native description sharing.
- Existing notes and greetings are preserved. New note edits attach to the exact character card. Ambiguous older name-based notes remain available for explicit assignment to a card.
- Desktop placement and resizing use native Moving UI when enabled; **Reset position** resets only this panel's saved geometry. Narrow screens use a scrolling panel within the viewport.

This checkout retains manifest version 1.8. Historical Presence remains deferred pending a safe host save integration.

### Version 1.8 — historical release notes

- Removed the Presence module. Presence was saving group chats a second time at the same moment SillyBunny saved them, which caused "Temp file rename failed ... EPERM" errors on Windows and could interrupt chat saving. With Presence gone, those errors stop. The per-message presence indicator icons (the little member avatars at the top of each message) are also removed, since they were part of Presence.
- Group Greetings, Group Utilities, and Send As are unchanged and continue to work as before.
- Improved how the extension loads its files so updates apply cleanly instead of running stale cached copies.
- Removed leftover Presence styling.

Historical v1.8 upgrade instructions for older installs:

- Delete your existing "SillyBunny-GroupUtilities" folder and reinstall it fresh. Do not unzip a new copy on top of the old one, or old Presence files can be left behind.
- Check BOTH extension locations and remove any duplicate copy, then keep only one:
  - public/scripts/extensions/third-party/SillyBunny-GroupUtilities
  - data/user/extensions/SillyBunny-GroupUtilities
- After reinstalling, hard refresh the server.

## Bundled Extensions

This extension is based on and credits the following upstream projects:

- ~~[SillyTavern Presence](https://github.com/leandrojofre/SillyTavern-Presence) by [leandrojofre](https://github.com/leandrojofre).~~
- [Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings) by [Cohee](https://github.com/Cohee1207).
- [st-group-utils](https://github.com/DummyTBanana/st-group-utils) by [city-unit](https://github.com/city-unit).
- [SillyTavern GroupSendAs](https://github.com/SillyTavern/SillyTavern-GroupSendAs) by [Cohee](https://github.com/Cohee1207).

## Features

- Group-only greetings for character cards, with random or manual selection modes.
- Group utility prompts that can share character information and group notes during generation.
- A Group Members panel for the active conversation, with shared notes and context preview.
- **Write as** prepares a `/sendas` draft using the host's character reference; **Ask to respond** requests a native generated reply.
- Optional current-scene controls, reviewed model-assisted scene suggestions, and styling for existing prose markup.
- Compact SillyBunny-specific current-member layout so Model Override and action buttons fit together more cleanly.

## Installation

Install through SillyBunny's built-in extension installer:

1. Open SillyBunny.
2. Go to **Extensions**.
3. Use the extension installer.
4. After the files are uploaded, paste `https://github.com/voldomero/SillyBunnyGCO`.
5. Disable any old Group Utilities copy, reload, then install and enable **SillyBunny Group Chat Overhaul**.
6. Restart or hard refresh SillyBunny after installation.

Keep only one active Group Utilities/GCO bundle and avoid duplicate standalone Greetings/Group Utilities/SendAs installations. Duplicate copies can register the same controls or generation interceptor more than once.

## Notes For SillyBunny

This is not a direct drop-in zip of the original extensions. It is a compatibility bundle with SillyBunny-specific changes:

- The bundled utilities load from one manifest and one extension entry.
- Member-row controls are coordinated so they do not fight SillyBunny's **Model Override** field.
- The legacy [SillyTavern-Presence](https://github.com/leandrojofre/SillyTavern-Presence) module was removed in v1.8 after its duplicate group-chat saves raced SillyBunny's own JSONL writes and produced `EPERM` temp-file errors on Windows. Current-scene controls use extension settings and do not restore that transcript writer or its historical presence indicators.
- Group utility notes are injected through SillyBunny's extension-prompt API instead of mutating the live generation chat array.
- Group utility settings, group greetings, and SendAs behavior remain available from the bundled extension.

## Usage

### Group Greetings

Open a character card or character creation form, then use the group greetings button near the first-message controls. You can add group-only greetings and choose whether SillyBunny picks one randomly or asks you to choose when starting a group chat.

### Group Utilities

Open **Group Members** from the Extensions menu or Group Utils settings. The panel shows the active conversation even when a different group is open in the editor. Select a member to edit their note or open **Context preview**. Preview shows additional extension context, not the entire host prompt.

Configure **Share group notes** and **Share character descriptions and height context** independently in Group Utils settings. To add a shortcut, enable **Show Group Members in the bottom bar**. The panel stays closed until opened.

With native Moving UI enabled on desktop, use the grip to move the panel and its lower-right corner to resize it. **Reset position** restores its default placement. Native automatic-reply availability is shown as read-only information; it is not a record of who was historically present.

### Group SendAs

Use **Write as** in Group Members, or the quote button in the native members list, to prepare a character's `/sendas` draft. Repeated use replaces the existing prefix and keeps the draft text and selection. Sending remains a separate action in the host composer.

**Ask to respond** requests a generated reply from the selected member. Finish or clear your draft first; this action is unavailable while the composer contains text or a response is running.

## Responder controls and Reply Rules

In **Group Utils**, enable **Show compact responder picker** to show controls near the composer. Choose a card by its name and filename; duplicate names remain separate. Muted cards stay visible. Asking a muted card explicitly requests a native manual reply; it does not enable automatic replies or change scene/knowledge state.

Ask requires an empty text draft and no pending file attachment or outstanding reply. Write as is also guarded while an extension reply request is outstanding. **Clear request** invalidates the extension's tracking; use the host's **Stop** control to stop a running generation. An unresolved request keeps its lock even after a timeout or clear, until its native call returns. A returned call is not proof that a reply was produced; there is no automatic follow-up or retry.

Open **Reply Rules** in settings and enable its local preview to configure:

- Exact-card aliases/trigger phrases and exclusions. Add each phrase in its own field; commas stay inside the phrase. Names and aliases use case-insensitive Unicode matching, with letter/number/mark/underscore boundaries and NFC normalization. A name embedded inside another word does not match. This does not infer whether someone is being addressed or discussed.
- Multiple addressed speakers and an all-eligible phrase (default `everyone`). Both obey mute/eligibility, exclusions and limits. Turn limits include participants, total replies and replies per character; zero permits none. Each selected card appears once, so a per-character limit above one does not create repeated replies.
- First-mention order or group order. Duplicate names or shared aliases are explained as ambiguous; use a unique alias to resolve them.
- Optional session focus using **Focus selected card**. It clears on disable, mute/ineligibility, unresolved membership or a conversation change. It is not saved or restored on reload.
- Fallback of **No automatic reply** (default), or the first eligible member. Selection priority is explicit choice, matching rules, focus, then fallback. An explicit or recognized request that is excluded/ambiguous does not unexpectedly fall through to another speaker.

Use **Text to preview**, or **Copy draft to preview**, to see decisions without changing or sending the composer. Rule configuration applies to exact cards across groups and saves through the existing settings path. Unresolved card settings remain stored; they are not reassigned by name. Settings suggesting a known competing automatic router produce an advisory warning. Other extensions are never disabled.

The preview and deterministic selection share one function, but **automatic execution is gated**. Ordinary sends, failed sends, Continue, Regenerate, swipes, greetings and Write as do not trigger an extension rule turn. The extension leaves native strategy unchanged; native behavior can still produce replies independently. When current-scene controls are enabled, explicitly absent cards are also excluded from this extension's Ask actions, preview and focus.

## Current scene

Open **Group Members**, select a card, expand **Current scene**, and enable its controls. Each card starts **unspecified** until you choose a state:

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

Milestone 3 remains **gated, not implemented**. The inspected hosts do not yet provide the complete witness-recording and per-speaker prompt contracts required here. Filtering a derived history alone would also leave supplemental World Info and other context sources uncontrolled. See the [host-contract review](MILESTONE3-HOST-CONTRACT.md) for the evidence and required edit, deletion, swipe, regeneration, branch, import and reload policies. Current-scene choices cannot fill those gaps.

## Optional scene suggestions

First enable current-scene controls in a group. In **Group Utils → Scene suggestions (optional)**, enable suggestions and explicitly choose a **direct OpenAI connection profile** with a saved model and credential selection. If the verified host request service or a supported profile is unavailable, requesting stays disabled. There is no automatic profile fallback.

Enter a description in **Describe the current scene**, then choose **Suggest scene changes**. Each request uses that connection and may cost money and take time. Along with fixed response-format instructions, it sends only the description you enter, exact card filenames, card names and current scene states. It does not include chat history, shared notes, character descriptions or the composer draft. The entered description and returned suggestions are not saved by this extension.

The response must pass strict validation: at most three proposals, unique known cards, valid current-to-new states, and no unsupported fields. Invalid responses are rejected. Review each explanation; a model suggestion can be wrong. **Apply change for [card]** applies only that proposal and clears the entire batch. Request fresh suggestions to consider another change. Nothing is applied automatically.

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
