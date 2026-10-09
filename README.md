# SillyBunny Group Chat Overhaul

> A SillyBunny group chat overhaul. Combines the old "Group Utilities" with new implementation, ideas, and fixes.

## Table of Contents

- [About](#about)
- [Install](#install)
- [Bundled Extensions](#bundled-extensions)
  - [Group Greetings](#group-greetings)
  - [Group Utilities](#group-utilities)
  - [Group SendAs](#group-sendas)
- [Changes](#changes)
- [Features](#features)
  - [Group Dynamics](#group-dynamics)
  - [Card-specific notes](#card-specific-notes)
  - [Context preview](#context-preview)
  - [Write as and Ask to respond](#write-as-and-ask-to-respond)
  - [Choose next responder](#choose-next-responder)
  - [Current Members](#current-members)
- [Optional Features](#optional-features)
  - [Shared context](#shared-context)
  - [Action-row shortcuts](#action-row-shortcuts)
  - [Compact responder picker](#compact-responder-picker)
  - [Reply Rules and focus](#reply-rules-and-focus)
  - [Automatic routing](#automatic-routing)
  - [Current scene](#current-scene)
  - [Scene memory](#scene-memory)
  - [Automatic presence](#automatic-presence)
  - [Scene suggestions](#scene-suggestions)
  - [Prose styling](#prose-styling)
- [Troubleshooting](#troubleshooting)
- [Credits, License & Inspirations](#credits-license--inspirations)

## About

SillyBunny Group Chat Overhaul (GCO) combines group greetings, shared character context and SendAs controls with a Group Dynamics panel for [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny/). It adds card-specific notes, responder selection, Reply Rules, scene states and optional memory filtering, automatic presence, model-assisted scene suggestions and prose styling.

GCO is designed for SillyBunny. Features that need additional host support show an explanation when unavailable. Most optional features start off; notes, description sharing and the Current Members shortcut start on.

## Install

1. Open **Extensions** in SillyBunny and select the extension installer.
2. Paste `https://github.com/voldomero/SillyBunnyGCO` and install.
3. Enable **SillyBunny Group Chat Overhaul**, then reload or hard refresh SillyBunny.
4. Open **Extensions → Group Chat Overhaul** to configure GCO or open **Group Dynamics**.

Disable standalone Group Greetings, Group Utilities or Group SendAs extensions if installed; GCO already includes them. No build or dependency installation is needed.

## Bundled Extensions

### Group Greetings

[Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings) adds alternate greetings used only in group chats. Open the group-greetings button beside a character's first-message controls to edit greetings and choose random or manual selection.

### Group Utilities

[st-group-utils](https://github.com/DummyTBanana/st-group-utils) supplies shared notes, limited character descriptions, height comparisons and context settings. GCO expands these with exact-card notes, independent sharing switches and a context preview.

### Group SendAs

[SillyTavern GroupSendAs](https://github.com/SillyTavern/SillyTavern-GroupSendAs) adds a quote button to the native members list to prepare a `/sendas` draft. GCO also exposes this as **Write as** in Group Dynamics and the compact responder picker.

## Changes

**SillyBunny Group Utilities → SillyBunny Group Chat Overhaul**

- Added **Group Dynamics** with member notes, context preview, scene controls, save feedback and desktop move/resize support.
- Added **compact responder controls**, **Reply Rules**, session focus, native next-speaker synchronization and automatic routing on compatible hosts.
- Added **current-scene states**, **scene memory**, late-join history controls and **automatic presence** with Undo.
- Added manual **scene suggestions** through saved chat/text connection profiles and optional **prose styling**.
- Improved native member-row layout alongside Model Override, added separate action-row shortcuts and made panels usable on narrow screens.
- Added pending-edit recovery, confirmed-save feedback and guards against applying replies or suggestions to a different conversation.

Bundled-extension updates:

- **Group Greetings:** reliable startup and cleanup, improved popup and keyboard controls, and saving popup edits on close while retaining existing greeting data.
- **Group Utilities:** exact-card notes, separate note/description switches, matching preview and generation context, corrected token limits and height comparisons, and protection against stale context.
- **Group SendAs:** exact-card targeting, escaped character references, replacement of an existing `/sendas` prefix, and preservation of draft text, caret and selection.
- **Bundle loading:** coordinated initialization, cleanup and cache handling across modules.

Existing settings and authored notes/greetings are retained. GCO's scene features are separate from the older Presence extension, which is not bundled.

## Features

### Group Dynamics

Open **Group Dynamics** from the Extensions menu or Group Chat Overhaul settings. It follows the active conversation and starts closed. Select a member to edit notes, inspect context or use reply controls.

On desktop, native **Moving UI** enables dragging and resizing. **Reset position** restores this panel's placement. Narrow screens use a scrolling panel within the viewport.

### Card-specific notes

Notes belong to the exact character card, so duplicate names remain separate. Older name-based notes that cannot be matched safely remain available for explicit assignment.

Notes and scene choices save through SillyBunny settings. Pending edits can recover in the same browser tab after a reload or server restart. Wait for save confirmation before closing the tab or changing devices.

### Context preview

Preview the extra context GCO would supply for the selected member, including shared notes, descriptions, height comparisons and reasons for omissions. With scene memory enabled, it also reports hidden-message counts. This preview covers GCO's contributions, not the complete model prompt.

### Write as and Ask to respond

- **Write as** prepares a `/sendas` draft. Repeated use replaces the prefix and keeps the draft; sending is a separate action.
- **Ask to respond / Ask now** requests one generated reply from the selected card. The composer must contain no text or pending attachment, and generation must be idle. An explicitly requested muted member can reply without changing its automatic-reply setting.

**Clear request** asks compatible hosts to cancel GCO's request. Native **Stop** remains available. Controls stay locked until the underlying request finishes; uncertain results do not trigger retries.

### Choose next responder

Choose who answers the next ordinary user message. On supported SillyBunny versions, this uses the same selection as the native speaker bar; changing either updates the other. **Clear next responder** clears the selection. A failed send keeps the choice for your next deliberate send.

This can work independently of automatic routing. Hosts without native speaker selection need compatible routing support. Muted, absent or rule-excluded cards and zero reply limits prevent selection.

### Current Members

**Current Members** opens SillyBunny's native roster, with automatic-reply toggles, Model Override and member-management buttons. **Group Dynamics** contains GCO's notes, scene settings and preview. The windows have separate shortcuts.

## Optional Features

### Shared context

In **Group Chat Overhaul**, toggle **Share group notes** and **Share character descriptions and height context** independently. Both default to on. Height comparisons use measurements found in descriptions.

Set insertion depth, description token limits, the stopping character and the maximum descriptions shared (`-1` means all). **Include In WI**, off by default, lets shared context participate in World Info matching. Description limits do not limit notes.

The macros `{{char_list}}` and `{{char_list_all}}` list available members with descriptions, excluding or including the current speaker respectively.

### Action-row shortcuts

Toggle **Show Group Dynamics in the action row** and **Show Current Members in the action row** separately. Dynamics defaults off; Current Members defaults on. Shortcuts appear beside Guided Impersonate and Flush Guides when that row is available.

### Compact responder picker

Enable **Show compact responder picker** to place responder controls near the composer. Cards are identified by name and filename. This is off by default and shares the same request handling as Group Dynamics.

### Reply Rules and focus

Enable **Reply Rules** to configure exact-card aliases, individual trigger phrases, exclusions, an all-eligible phrase such as `everyone`, speaker order and reply limits. Matching is literal and case-insensitive; it does not infer intent. Use unique aliases for duplicate names.

**Text to preview** and **Copy draft to preview** explain selections without sending anything. Optional **Focus selected card** provides session-only focus; it clears when the conversation changes or the card becomes ineligible. Rules default off, with no automatic fallback. Each selected card appears once per routed turn.

### Automatic routing

With Reply Rules enabled, choose **Enable automatic routing for this chat**. This requires compatible host support and starts off after reload. The selection order is explicit choice, matching rules, focus, then the configured fallback.

Replies run in order after confirmed saves. Native speaker/strategy changes, manual actions or chat switches end automatic routing. Stop, failed saves, timeouts or uncertain completion end the current turn without retries. **Clear request** also turns automatic routing off. A detected competing router prevents activation. Routed replies require tool calling to be off and suppress auto-continue and auto-swipe.

### Current scene

In **Group Dynamics → Current scene**, enable scene controls and set each member to **Present**, **Absent**, **Remotely connected** or **Unspecified**. The feature defaults off; new cards start unspecified.

Absent members are excluded from GCO's Ask actions, Reply Rules and focus. Scene choices do not change group membership or mute settings. Turning controls off keeps saved choices and removes these restrictions. Native reply selection can act independently when GCO does not own routing.

Choices belong to the exact card and conversation. A new, branched or renamed chat starts unspecified, except that scene memory can restore absence recorded at its newest message, with Undo.

### Scene memory

Enable current-scene controls, then **Scene memory**. It defaults off and requires compatible host support. New messages record who was absent; those messages are hidden from that member's reply context. Members added mid-chat also miss earlier messages, except their own.

- **Knows everything** lets the selected card see all messages across chats and can be toggled off again.
- **Show earlier messages**, or **Undo** on the join notice, permanently removes that member's earlier-message restriction. Removing and re-adding the card does not restore it.
- Messages written before memory was enabled, or while it was off, have no absence record; later-join restrictions still apply.
- After renaming a card, its missed messages remain hidden only in chats where it has written a message.
- Hidden messages are excluded from World Info keyword matching for that reply. Summaries, lorebook entries, macros and other extensions can still reveal missed information.
- If Vocalia's history filter is enabled, GCO leaves filtering to Vocalia.

Scene memory stores small records in chat data alongside the host's normal saves.

### Automatic presence

With scene memory enabled, toggle **Automatic presence**. It defaults off and detects simple English arrival/departure lines such as “Alice walks in” or “Bob heads out.”

Changes in user messages apply before replies; changes in replies wait until the round ends. Notices and **Latest automatic changes** provide **Undo**. This uses text rules, not a model request.

### Scene suggestions

Enable **Scene suggestions** in Group Chat Overhaul and explicitly select a supported saved connection profile. Current-scene controls must also be on. Suggestions default off and use SillyBunny's chat/text completion service without switching the active chat connection.

Enter a scene description and choose **Suggest scene changes**. Each request may incur provider costs. GCO sends the entered description, card names/filenames and current scene states; it excludes chat history, notes and the composer draft. The profile's custom request settings also apply.

Review up to three proposals. **Apply change** applies one proposal and clears the batch. Nothing applies automatically, and GCO does not save the entered description or returned proposals. Automatic speaker/turn suggestions are unavailable.

### Prose styling

Enable **Style existing quotes and action emphasis in group chats** for stronger quotes and a subtle theme-colored emphasis background. It defaults off, uses the host's existing formatting and excludes code. Message text stays unchanged; no model call or special reply format is needed.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Missing or duplicate controls | Reload or hard refresh after installation/update. Disable duplicate standalone copies of the bundled extensions. |
| Ask is unavailable | Send or clear the draft and attachment, wait for the current request, and check whether the card is marked absent. Use native Stop for running generation. |
| Next responder or automatic routing is unavailable | These have separate host requirements. Read the control's explanation; automatic routing also checks for competing routers. Manual Ask and rule preview remain available. |
| Notes or descriptions are missing | Check the independent sharing switches and Context preview. Confirm the selected card and assign any unresolved older note explicitly. |
| A save is pending or failed | Keep the tab open and use **Retry saving**. If offered, use **Download recovery copy** to retain conflicting edits. |
| Scene memory or automatic presence is unavailable | Enable current-scene controls and check the host-support explanation. Presence also requires scene memory. |
| A member still knows something it missed | Review the Scene memory limits, **Knows everything**, earlier-message reveals and other context sources. Check whether Vocalia is handling filtering. |
| Scene suggestions fail | Check the selected saved profile's address, model and credentials. Legacy KoboldAI, Horde and NovelAI profiles are unsupported by the background service; KoboldCpp text-completion profiles are supported. There is no automatic profile fallback. |
| Current Members will not open | Open a group conversation and finish or leave any new-character or new-group form. |
| Group Dynamics is misplaced | Use **Reset position**. Dragging/resizing requires native Moving UI on desktop. |

## Credits, License & Inspirations

Bundled work and contributors:

- [Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings) — Cohee and contributors.
- [st-group-utils](https://github.com/DummyTBanana/st-group-utils) — city-unit / Ubunifu and contributors.
- [SillyTavern GroupSendAs](https://github.com/SillyTavern/SillyTavern-GroupSendAs) — Cohee, Saref111 and contributors.

The repository's [LICENSE](LICENSE) contains GPL-3.0 terms. Group Greetings and GroupSendAs declare AGPL-3.0; st-group-utils declares CC BY-SA without specifying a version. Bundled upstream code retains its original license notices and terms.

Inspirations for GCO's scene, responder and context features:

- [SillyTavern Presence](https://github.com/leandrojofre/SillyTavern-Presence)
- [STGroupResponderSelector](https://github.com/thexyzzyone/STGroupResponderSelector)
- [Natural-Extended](https://github.com/Spiriax/Natural-Extended)
- [Aspect: Vocalia](https://github.com/Vectricity/st-aspect-vocalia)

These inspiration projects are not bundled with GCO.
