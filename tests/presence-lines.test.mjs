import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PRESENCE_WORDS, detectPresence } from '../src/presence-lines.js';

const members = [
    { avatar: 'alice.png', name: 'Alice', aliases: ['Ally'] },
    { avatar: 'bob.png', name: 'Bob' },
    { avatar: 'carol.png', name: 'Carol' },
    { avatar: 'rose.png', name: 'Rose Tyler' },
    { avatar: 'will.png', name: 'Will Turner' },
    { avatar: 'zoe.png', name: 'Zoë' },
    { avatar: 'elise.png', name: 'Élise' },
    { avatar: 'mia1.png', name: 'Mia Smith' },
    { avatar: 'mia2.png', name: 'Mia Jones' },
];

const detect = (text, extra = {}) => detectPresence(text, { members, persona: '', kind: 'user', ...extra })
    .map(({ avatar, to }) => `${avatar}:${to}`);

const DETECT = [
    ['Alice walks in.', ['alice.png:present']],
    ['Bob grabs his coat and leaves.', ['bob.png:absent']],
    ['Alice and Bob leave.', ['alice.png:absent', 'bob.png:absent']],
    ['Alice, Bob & Carol walk in.', ['alice.png:present', 'bob.png:present', 'carol.png:present']],
    ['Finally, Carol returns home.', ['carol.png:present']],
    ['Suddenly Bob quietly leaves.', ['bob.png:absent']],
    ['Bob heads out the door.', ['bob.png:absent']],
    ['Bob steps out into the rain.', ['bob.png:absent']],
    ['Alice has arrived.', ['alice.png:present']],
    ['Alice and Bob have left.', ['alice.png:absent', 'bob.png:absent']],
    ['*Alice walks in.*', ['alice.png:present']],
    ['Ally walks in.', ['alice.png:present']],
    ['Zoë walks in. Élise leaves.', ['zoe.png:present', 'elise.png:absent']],
    ['Bob is back.', ['bob.png:present']],
    ['Bob is gone.', ['bob.png:absent']],
    ['Bob leaves. Later, Bob comes back.', ['bob.png:present']],
    ['Then Bob joins us.', ['bob.png:present']],
    ['Rose leaves.', ['rose.png:absent']],
    ['Rose Tyler shows up.', ['rose.png:present']],
    ['Bob leaves, and Alice walks in.', ['bob.png:absent', 'alice.png:present']],
    ['The sun rose and Bob leaves.', ['bob.png:absent']],
    ['Will walks in.', ['will.png:present']],
    ['Mia Smith walks in.', ['mia1.png:present']],
    ['Bob storms off. Carol steps in.', ['bob.png:absent', 'carol.png:present']],
];

const IGNORE = [
    "Bob doesn't leave.", 'Bob does not leave.', 'Bob never leaves.',
    'Bob will leave tomorrow.', 'Bob can leave.', 'Bob might leave.', 'Bob is going to leave.',
    'Bob had left.', 'Bob is leaving.', 'Is Alice here?', 'Does Bob leave?',
    'If Bob leaves, Alice cries.', 'When Alice arrives, we eat.',
    '"I\'m leaving," Bob says.', '"Bob leaves," she said.', '“Bob leaves.”', '«Bob leaves»',
    'I saw Bob leave.', 'Bob, leave!', 'Bob leaves a note.', 'Alice arrives tomorrow.',
    'Bob returns the book.', 'will walks in.', 'rose walks in.', 'Mia walks in.',
    'He leaves.', 'Everyone leaves.', 'Alice and Bob leaves.',
    '`Bob leaves`', '[OOC Bob leaves]', '((Bob leaves))', 'I head out.', '*walks out*',
    'Bob had grabbed his coat and left.', 'Bob had already gone and left.', "Bob would've grabbed his coat and left.",
    'Alice, Bob left.', 'Alice, Bob, Carol leave.',
];

describe('presence corpus', () => {
    for (const [text, expected] of DETECT) {
        test(`detects ${text}`, () => assert.deepEqual(detect(text), expected));
    }
    for (const text of IGNORE) {
        test(`ignores ${text}`, () => assert.deepEqual(detect(text), []));
    }
});

describe('presence detector', () => {
    test('reads first person and bare narration as the author in character lines', () => {
        const character = { kind: 'character', author: 'bob.png' };
        assert.deepEqual(detect('I head out.', character), ['bob.png:absent']);
        assert.deepEqual(detect('*walks out*', character), ['bob.png:absent']);
        assert.deepEqual(detect("I'm back.", character), ['bob.png:present']);
        const narrator = { kind: 'narrator', author: 'bob.png' };
        assert.deepEqual(detect('I head out.', narrator), []);
        assert.deepEqual(detect('*walks out*', narrator), []);
    });

    test('drops a first name the persona shares', () => {
        assert.deepEqual(detect('Will walks in.', { persona: 'Will Hart' }), []);
        assert.deepEqual(detect('Will Turner walks in.', { persona: 'Will Hart' }), ['will.png:present']);
        assert.deepEqual(detect('Bob leaves.', { persona: 'Bob' }), []);
    });

    test('keeps the last mention of each member, ordered by that mention', () => {
        assert.deepEqual(detect('Alice leaves. Bob leaves. Alice walks in.'), ['bob.png:absent', 'alice.png:present']);
        assert.deepEqual(detect('Bob leaves and comes back.'), ['bob.png:present']);
    });

    test('treats odd avatar strings as exact keys', () => {
        const odd = [
            { avatar: '__proto__', name: 'Proto' },
            { avatar: 'constructor', name: 'Conn' },
            { avatar: 'two words.png', name: 'Sam' },
            { avatar: 'иван.png', name: 'Иван' },
        ];
        const result = detectPresence('Proto walks in. Conn leaves. Sam and Иван leave.', { members: odd, kind: 'user' });
        assert.deepEqual(result.map(({ avatar, to }) => [avatar, to]), [
            ['__proto__', 'present'], ['constructor', 'absent'], ['two words.png', 'absent'], ['иван.png', 'absent'],
        ]);
        assert.ok(result.every(entry => Object.getPrototypeOf(entry) === Object.prototype));
        assert.deepEqual(detectPresence('I head out.', { members: odd, kind: 'character', author: '__proto__' }),
            [{ avatar: '__proto__', to: 'absent' }]);
    });

    test('ignores members whose card identity is shared or missing', () => {
        const roster = [
            { avatar: 'dup.png', name: 'Dana' },
            { avatar: 'dup.png', name: 'Dora' },
            { avatar: '', name: 'Eve' },
            { name: 'Fay' },
            { avatar: 'bob.png', name: 'Bob' },
        ];
        const result = detectPresence('Dana leaves. Dora leaves. Eve leaves. Fay leaves. Bob leaves.', { members: roster, kind: 'user' });
        assert.deepEqual(result, [{ avatar: 'bob.png', to: 'absent' }]);
        assert.deepEqual(detectPresence('I head out.', { members: roster, kind: 'character', author: 'dup.png' }), []);
    });

    test('drops a phrase two cards share and never guesses an owner', () => {
        const roster = [
            { avatar: 'alice.png', name: 'Alice', aliases: ['Boss'] },
            { avatar: 'bob.png', name: 'Bob', aliases: ['boss'] },
        ];
        assert.deepEqual(detectPresence('Boss leaves.', { members: roster, kind: 'user' }), []);
        assert.deepEqual(detect('Mia and Bob leave.'), []);
    });

    test('reads the author only from a member card', () => {
        assert.deepEqual(detect('I head out.', { kind: 'character', author: 'stranger.png' }), []);
        assert.deepEqual(detect('I head out.', { kind: 'character' }), []);
    });

    test('never reads first person together with members', () => {
        assert.deepEqual(detect('Bob and I head out.'), []);
        assert.deepEqual(detect('Bob and I head out.', { kind: 'character', author: 'alice.png' }), []);
    });

    test('reads a contraction but never a possessive as the subject', () => {
        assert.deepEqual(detect("Alice's dog leaves."), []);
        assert.deepEqual(detect("Bob's back."), ['bob.png:present']);
        assert.deepEqual(detect('Bob’s gone.'), ['bob.png:absent']);
        assert.deepEqual(detect("Bob's back hurts."), []);
    });

    test('reads an emphasised action as the author only at the start of a clause', () => {
        const character = { kind: 'character', author: 'bob.png' };
        assert.deepEqual(detect('See you later! *walks out*', character), ['bob.png:absent']);
        assert.deepEqual(detect('"See you later." *walks out*', character), ['bob.png:absent']);
        assert.deepEqual(detect('Alice *walks in*', character), ['alice.png:present']);
        assert.deepEqual(detect('See you later *walks out*', character), []);
        assert.deepEqual(detect('She *walks* out', character), []);
        assert.deepEqual(detect('See you later! *walks out*'), []);
    });

    test('never reads an emphasised verb inside a clause as the author', () => {
        const character = { kind: 'character', author: 'carol.png' };
        for (const text of [
            'He never *left*.', 'He will not have *left*.', 'If he *leaves*, I cry.', "I can't believe he *left*.",
            'Alice watches as Bob *leaves*', 'Nobody *leaves* this room.', 'She *left* him there.',
            'You *left*! You just *left* me there!', 'My dad *left*.',
        ]) {
            assert.deepEqual(detect(text, character), [], text);
        }
    });

    test('rejects hedging adverbs and accepts plain ones', () => {
        for (const text of [
            'Bob nearly leaves.', 'Bob probably leaves.', 'Bob rarely leaves.', 'Bob hardly leaves.',
            'Bob frequently leaves.', 'Bob regularly leaves.', 'Bob allegedly left.', 'Bob hopefully leaves.',
            'Bob presumably left.', 'Bob wont stay and leaves.', 'Bob cant stay and leaves.',
            "Bob'll grab his coat and leave.", "Bob said he'd stay and left.",
        ]) {
            assert.deepEqual(detect(text), [], text);
        }
        assert.deepEqual(detect('Bob finally leaves.'), ['bob.png:absent']);
    });

    test('never splits a conditional or a question into a statement', () => {
        assert.deepEqual(detect('If Bob leaves and Alice walks in, we eat.'), []);
        assert.deepEqual(detect('Bob leaves and Alice walks in?'), []);
        assert.deepEqual(detect('Bob leaves and Alice walks in?!'), []);
    });

    test('never splits an object list or a reported clause', () => {
        assert.deepEqual(detect('Alice watched as Bob and Carol left.'), []);
        assert.deepEqual(detect('Bob says that Alice leaves and Carol walks in.'), []);
        assert.deepEqual(detect('Alice watched Bob, and Carol left.'), ['carol.png:absent']);
    });

    test('drops single-quoted dialogue and parenthesised out-of-character notes', () => {
        assert.deepEqual(detect('‘Bob leaves,’ she said.'), []);
        assert.deepEqual(detect('‘I’m leaving,’ Bob says.'), []);
        assert.deepEqual(detect('(OOC: Bob leaves)'), []);
        assert.deepEqual(detect('[ooc: Bob leaves]'), []);
        assert.deepEqual(detect('"Bye." Bob leaves.'), ['bob.png:absent']);
    });

    test('drops fenced code and an unclosed quote up to the end of its line', () => {
        assert.deepEqual(detect('```\nBob leaves.\n```\nAlice walks in.'), ['alice.png:present']);
        assert.deepEqual(detect('"Bob leaves.\nAlice walks in.'), ['alice.png:present']);
        assert.deepEqual(detect('“Bob leaves.\n\nAlice walks in.'), ['alice.png:present']);
    });

    test('drops a quote that runs over a line break', () => {
        for (const text of [
            '"Stay here.\nBob leaves," she says.', '“Stay here.\nBob leaves,” she says.',
            '“Stay here.\n\nBob leaves,” she says.', '«Stay here.\nBob leaves,» she says.',
        ]) {
            assert.deepEqual(detect(text), [], text);
        }
        assert.deepEqual(detect('"Stay here."\n\nBob leaves.'), ['bob.png:absent']);
    });

    test('drops straight single-quoted dialogue but keeps elisions', () => {
        assert.deepEqual(detect("'Bob leaves,' she said."), []);
        assert.deepEqual(detect("'I'm leaving,' Bob says."), []);
        assert.deepEqual(detect("'Bye.' Bob leaves."), ['bob.png:absent']);
        assert.deepEqual(detect("Bob's back. Bob leaves 'em."), ['bob.png:present']);
        assert.deepEqual(detect("'Bob leaves"), []);
    });

    test('accepts the listed tails and nothing longer', () => {
        assert.deepEqual(detect('Bob leaves for the city.'), ['bob.png:absent']);
        assert.deepEqual(detect('Alice arrives at the inn with Bob.'), ['alice.png:present']);
        assert.deepEqual(detect('Bob walks out through the door.'), ['bob.png:absent']);
        assert.deepEqual(detect('Bob enters the room.'), ['bob.png:present']);
        assert.deepEqual(detect('Bob leaves for a long time.'), []);
        assert.deepEqual(detect('Bob enters the conversation.'), []);
    });

    test('limits the subject to four members', () => {
        assert.deepEqual(detect('Alice, Bob, Carol and Zoë leave.'),
            ['alice.png:absent', 'bob.png:absent', 'carol.png:absent', 'zoe.png:absent']);
        assert.deepEqual(detect('Alice, Bob, Carol, Zoë and Élise leave.'), []);
    });

    test('splits at an ampersand like and', () => {
        assert.deepEqual(detect('Bob leaves & Alice walks in.'), ['bob.png:absent', 'alice.png:present']);
    });

    test('ends a clause at closing punctuation with no words after it', () => {
        assert.deepEqual(detect('(Alice walks in)'), ['alice.png:present']);
        assert.deepEqual(detect('(Alice walks in) to say hi'), []);
    });

    test('matches names with inner punctuation and decomposed text', () => {
        const roster = [{ avatar: 'watson.png', name: 'Dr. Watson' }, ...members];
        assert.deepEqual(detectPresence('Dr. Watson leaves.', { members: roster, kind: 'user' }),
            [{ avatar: 'watson.png', to: 'absent' }]);
        assert.deepEqual(detect('Zoë walks in.'), ['zoe.png:present']);
        assert.deepEqual(detect('ALICE walks in.'), ['alice.png:present']);
    });

    test('returns nothing for unusable input', () => {
        assert.deepEqual(detectPresence(42, { members, kind: 'user' }), []);
        assert.deepEqual(detectPresence('Bob leaves.', { members: null, kind: 'user' }), []);
        assert.deepEqual(detectPresence('Bob leaves.', {}), []);
        assert.deepEqual(detectPresence('', { members, kind: 'user' }), []);
    });

    test('keeps every word list in one deeply frozen table', () => {
        for (const key of [
            'leads', 'arrivals', 'departures', 'forms', 'tails', 'places', 'negations', 'modals', 'subordinators', 'questions',
            'firstPerson', 'pastPerfect', 'hedgeEndings', 'complementizers',
        ]) {
            assert.ok(Object.hasOwn(PRESENCE_WORDS, key), key);
        }
        const unfrozen = [];
        const visit = (value, path) => {
            if (value === null || typeof value !== 'object') return;
            if (!Object.isFrozen(value)) unfrozen.push(path);
            for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
        };
        visit(PRESENCE_WORDS, 'PRESENCE_WORDS');
        assert.deepEqual(unfrozen, []);
    });
});
