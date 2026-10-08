import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createChatSaver } from '../src/scene-saves.js';
import { createFakeHost } from './helpers/fake-host.mjs';

async function setup(options = {}) {
    const fake = await createFakeHost(options);
    fake.context.chat.push(fake.message({ avatar: 'alice.png', mes: 'Hello.' }));
    const logs = [];
    const saver = createChatSaver({ host: fake.host, now: fake.clock.now, log: (...args) => logs.push(args) });
    const key = fake.host.activeConversation().key;
    return { fake, saver, logs, key };
}

describe('chat save gate', () => {
    test('saves only a loaded header', async () => {
        const { fake, saver, key } = await setup();
        assert.equal(await saver.save(), false);
        assert.equal(fake.saves.length, 0);
        saver.markLoaded(fake.context.chatMetadata, key);
        assert.equal(saver.isLoaded(), true);
        assert.equal(await saver.save(), true);
        assert.equal(fake.saves.length, 1);
    });

    test('a header replaced by a load is no longer marked', async () => {
        const { fake, saver, key } = await setup();
        saver.markLoaded(fake.context.chatMetadata, key);
        fake.context.chatMetadata = { integrity: 'other' };
        assert.equal(saver.isLoaded(), false);
        assert.equal(await saver.save(), false);
    });

    test('a mark for another chat key does not count', async () => {
        const { fake, saver } = await setup();
        saver.markLoaded(fake.context.chatMetadata, JSON.stringify(['g1', 'older-chat']));
        assert.equal(saver.isLoaded(), false);
    });

    test('adopts the header at the first message event', async () => {
        const { fake, saver } = await setup();
        saver.adopt();
        assert.equal(await saver.save(), true);
        assert.equal(fake.saves.length, 1);
    });

    test('never saves an empty chat', async () => {
        const { fake, saver } = await setup();
        saver.adopt();
        fake.context.chat.splice(0);
        assert.equal(await saver.save(), false);
        assert.equal(fake.saves.length, 0);
    });

    test('passes allowShrink only inside the delete window', async () => {
        const { fake, saver } = await setup();
        saver.adopt();
        saver.noteDelete();
        fake.clock.tick(1400);
        await saver.save();
        fake.clock.tick(200);
        await saver.save();
        assert.deepEqual(fake.saves.map(save => save.options), [{ allowShrink: true }, {}]);
    });

    test('a delete in another chat does not open the window', async () => {
        const { fake, saver, key } = await setup();
        saver.noteDelete();
        fake.context.chatId = 'c2';
        fake.group.chat_id = 'c2';
        saver.markLoaded(fake.context.chatMetadata, JSON.stringify(['g1', 'c2']));
        assert.notEqual(fake.host.activeConversation().key, key);
        await saver.save();
        assert.deepEqual(fake.saves.map(save => save.options), [{}]);
    });

    test('flushes only when unsaved', async () => {
        const { fake, saver } = await setup();
        saver.adopt();
        assert.equal(await saver.flush(), false);
        assert.equal(fake.saves.length, 0);
        saver.markUnsaved();
        assert.equal(saver.hasUnsaved(), true);
        assert.equal(await saver.flush(), true);
        assert.equal(saver.hasUnsaved(), false);
        assert.equal(await saver.flush(), false);
        assert.equal(fake.saves.length, 1);
    });

    test('keeps the unsaved flag and logs once when a save is refused', async () => {
        const { fake, saver, logs } = await setup({ saveResult: false });
        saver.adopt();
        saver.markUnsaved();
        assert.equal(await saver.save(), false);
        assert.equal(await saver.save(), false);
        assert.equal(saver.hasUnsaved(), true);
        assert.equal(logs.length, 1);
        assert.equal(fake.saves.length, 2);
    });

    test('notifies onSaved with the result and key', async () => {
        const { saver, key } = await setup();
        const seen = [];
        const unsubscribe = saver.onSaved((ok, savedKey) => seen.push([ok, savedKey]));
        saver.adopt();
        await saver.save();
        unsubscribe();
        await saver.save();
        assert.deepEqual(seen, [[true, key]]);
    });

    test('tells listeners the header fields as they were when the save started', async () => {
        const { fake, saver } = await setup();
        const carried = [];
        saver.onSaved((ok, savedKey, header) => carried.push(header));
        fake.context.chatMetadata.note = 'sent';
        saver.adopt();
        let finish;
        fake.context.saveChat = () => new Promise(resolve => { finish = resolve; });
        const saving = saver.save();
        fake.context.chatMetadata.note = 'later';
        finish(true);
        await saving;
        assert.equal(carried[0].note, 'sent');
        assert.notEqual(carried[0], fake.context.chatMetadata);
    });

    test('reset clears the unsaved flag and the delete window', async () => {
        const { fake, saver } = await setup();
        saver.adopt();
        saver.markUnsaved();
        saver.noteDelete();
        saver.reset();
        assert.equal(saver.hasUnsaved(), false);
        await saver.save();
        assert.deepEqual(fake.saves.map(save => save.options), [{}]);
    });

    test('treats a host without saveChat as not saved', async () => {
        const { fake, saver } = await setup();
        delete fake.context.saveChat;
        saver.adopt();
        assert.equal(await saver.save(), false);
    });
});
