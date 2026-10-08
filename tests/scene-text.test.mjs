import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCENE_TEXT, textParts } from '../src/scene-text.js';

test('fills each token with its part, in the template\'s order', () => {
    const name = { node: 'name' };
    const count = { node: 'count' };
    assert.deepEqual(textParts('Lines {name} missed: {n}', { name, n: count }), ['Lines ', name, ' missed: ', count]);
    assert.deepEqual(textParts('{n} before {name}', { name, n: count }), [count, ' before ', name]);
});

test('leaves out a token without a part and keeps text without tokens whole', () => {
    assert.deepEqual(textParts('Joined after {last}.', {}), ['Joined after ', '.']);
    assert.deepEqual(textParts('Scene memory', { n: 1 }), ['Scene memory']);
    assert.deepEqual(textParts(undefined, {}), []);
});

test('every string is written', () => {
    for (const [key, value] of Object.entries(SCENE_TEXT)) {
        assert.equal(typeof value, 'string', key);
        assert.ok(value.trim() && value !== 'lorum ipsum', key);
    }
});
