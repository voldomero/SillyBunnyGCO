// Pure, English-only presence detection. It reports intent; the recorder decides what changes.
const deepFreeze = value => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
};

export const PRESENCE_WORDS = deepFreeze({
    leads: ['then', 'finally', 'suddenly', 'soon', 'later', 'eventually', 'meanwhile', 'moments later', 'just then'],
    // `phrases` take one or two words after them and then end the clause: "walks into the room".
    arrivals: [
        { verb: 'walk', particles: ['in'], phrases: ['into'] },
        { verb: 'come', particles: ['in', 'back'], phrases: ['into'] },
        { verb: 'step', particles: ['in'], phrases: ['into'] },
        { verb: 'arrive' },
        { verb: 'enter' },
        { verb: 'return', phrases: ['to'] },
        { verb: 'show', particles: ['up'] },
        { verb: 'join', objects: ['us', 'them', 'the group'] },
        { verb: 'be', particles: ['back', 'here'] },
    ],
    departures: [
        { verb: 'leave' },
        { verb: 'walk', particles: ['out', 'away'], phrases: ['out of'] },
        { verb: 'step', particles: ['out', 'away'], phrases: ['out of'] },
        { verb: 'head', particles: ['out', 'off', 'home'], phrases: ['out of'] },
        { verb: 'go', particles: ['out', 'home'], phrases: ['out of'] },
        { verb: 'exit' },
        { verb: 'depart' },
        { verb: 'storm', particles: ['out', 'off'], phrases: ['out of'] },
        { verb: 'disappear' },
        { verb: 'be', particles: ['gone'] },
    ],
    // Base, third person singular, past, past participle.
    forms: {
        walk: ['walk', 'walks', 'walked', 'walked'],
        come: ['come', 'comes', 'came', 'come'],
        step: ['step', 'steps', 'stepped', 'stepped'],
        arrive: ['arrive', 'arrives', 'arrived', 'arrived'],
        enter: ['enter', 'enters', 'entered', 'entered'],
        return: ['return', 'returns', 'returned', 'returned'],
        show: ['show', 'shows', 'showed', 'shown'],
        join: ['join', 'joins', 'joined', 'joined'],
        leave: ['leave', 'leaves', 'left', 'left'],
        head: ['head', 'heads', 'headed', 'headed'],
        go: ['go', 'goes', 'went', 'gone'],
        exit: ['exit', 'exits', 'exited', 'exited'],
        depart: ['depart', 'departs', 'departed', 'departed'],
        storm: ['storm', 'storms', 'stormed', 'stormed'],
        disappear: ['disappear', 'disappears', 'disappeared', 'disappeared'],
    },
    be: { one: ['is', 'was'], many: ['are', 'were'], self: ['am', 'was'] },
    perfect: { one: ['has'], many: ['have'], self: ['have'] },
    pastPerfect: ['had'],
    // Case-sensitive, after ’ becomes '.
    firstPerson: { plain: ['I'], be: ['I\'m'], perfect: ['I\'ve'] },
    tails: ['home', 'inside', 'outside', 'back', 'away', 'again'],
    doorTails: ['through the door', 'out the door'],
    articles: ['the', 'a', 'an'],
    places: [
        'room', 'door', 'doorway', 'house', 'building', 'hall', 'hallway', 'corridor', 'kitchen', 'office',
        'apartment', 'flat', 'cabin', 'camp', 'tent', 'hut', 'tavern', 'inn', 'bar', 'pub', 'shop', 'store',
        'library', 'garden', 'yard', 'porch', 'balcony', 'cellar', 'basement', 'attic', 'castle', 'palace',
        'manor', 'ship', 'car', 'chamber', 'study', 'lobby', 'lounge', 'bedroom', 'bathroom', 'classroom',
        'cave', 'temple', 'church', 'station', 'restaurant', 'cafe', 'café', 'clearing',
    ],
    prepositions: ['at', 'into', 'from', 'for'],
    splitters: ['and', 'but', 'then'],
    closers: ['and', 'but', 'as', 'while', 'with'],
    negations: [
        'not', 'no', 'never', 'cannot', 'nobody', 'nothing', 'neither', 'nor', 'without',
        'hardly', 'barely', 'scarcely', 'rarely', 'seldom', 'nearly', 'almost',
        'wont', 'cant', 'dont', 'doesnt', 'didnt', 'isnt', 'wasnt', 'arent', 'werent', 'hasnt', 'havent',
        'hadnt', 'couldnt', 'wouldnt', 'shouldnt', 'shant', 'mustnt', 'aint',
    ],
    modals: [
        'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'ought',
        'gonna', 'gotta', 'wanna', 'going', 'probably', 'possibly', 'likely', 'maybe', 'perhaps',
        'supposedly', 'apparently', 'reportedly', 'allegedly', 'presumably', 'hopefully', 'potentially',
        'theoretically', 'conceivably', 'practically', 'virtually',
        'usually', 'normally', 'typically', 'generally', 'occasionally', 'often', 'sometimes', 'always',
        'frequently', 'regularly', 'constantly', 'repeatedly', 'hourly', 'daily', 'nightly', 'weekly',
        'monthly', 'yearly',
    ],
    // Contracted not, will and had or would.
    hedgeEndings: ['n\'t', '\'ll', '\'d'],
    subordinators: [
        'if', 'when', 'whenever', 'unless', 'until', 'till', 'before', 'after', 'because', 'since',
        'although', 'though', 'while', 'whether', 'once', 'as', 'whereas', 'wherever', 'lest',
    ],
    questions: ['who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose', 'whom'],
    complementizers: ['that'],
});

const table = PRESENCE_WORDS;
const phraseWords = phrase => phrase.split(' ');
const LEADS = table.leads.map(phraseWords).sort((left, right) => right.length - left.length);
const DOOR_TAILS = table.doorTails.map(phraseWords);
const TAILS = new Set(table.tails);
const ARTICLES = new Set(table.articles);
const PLACES = new Set(table.places);
const PREPOSITIONS = new Set(table.prepositions);
const SPLITTERS = new Set(table.splitters);
const CLOSERS = new Set(table.closers);
const HEDGES = new Set([...table.negations, ...table.modals, ...table.pastPerfect]);
const SUBORDINATE = new Set([...table.subordinators, ...table.questions]);
const EMBEDDING = new Set([...SUBORDINATE, ...table.complementizers]);
const ENTRIES = [
    ...table.arrivals.map(entry => ({ ...entry, to: 'present' })),
    ...table.departures.map(entry => ({ ...entry, to: 'absent' })),
].map(entry => ({ ...entry, objects: entry.objects?.map(phraseWords), phrases: entry.phrases?.map(phraseWords) }));
const VERBS = ENTRIES.filter(entry => entry.verb !== 'be');
const STATES = ENTRIES.filter(entry => entry.verb === 'be');
// Form slots per subject: one member, several, first person, or a bare verb meaning the author.
const SLOTS = Object.freeze({ one: [1, 2], many: [0, 2], self: [0, 2], bare: [1, 2] });
const PARTICIPLE = 3;

// Same boundary class as matchPhrase in reply-rules.js.
const BOUNDARY = '[\\p{L}\\p{N}\\p{M}_]';
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu;
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/uy;
const POSSESSIVE = new RegExp(`['’]s(?!${BOUNDARY})`, 'uy');
const SPACE = /\s/u;
const QUOTE_MARK = /[\p{Pi}\p{Pf}"'„‚「」『』]/u;
const EMPHASIS = /[*_~]+/gu;
const BREAK = /[.!?;:…\n‒-―⸺⸻]+|-{2,}|\s-(?=\s)/gu;
// A quote may run over lines within one paragraph; one never closed there is dropped to the end of its line.
const quoted = (open, close) => String.raw`${open}(?:[^${close}\n]|\n(?!\s*\n))*[${close}]|${open}[^${close}\n]*`;
// A closing mark with no opening mark before it on its line ends a quote that opened in an earlier paragraph.
const quoteEnd = (open, close) => String.raw`^[^${open}${close}\n]*${close}`;
const HIDDEN = new RegExp([
    String.raw`\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$(?![\s\S]))`,
    String.raw`\x60[^\x60\n]*(?:\x60|$)`,
    String.raw`\(\([\s\S]*?(?:\)\)|$(?![\s\S]))`,
    String.raw`\[\s*OOC\b[\s\S]*?(?:\]|$(?![\s\S]))`,
    String.raw`\(\s*OOC\b[\s\S]*?(?:\)|$(?![\s\S]))`,
    quoted('"', '"'),
    quoted('“', '”'),
    quoteEnd('“', '”'),
    quoted('„', '“”'),
    quoted('«', '»'),
    quoteEnd('«', '»'),
    quoted('「', '」'),
    quoteEnd('「', '」'),
    quoted('『', '』'),
    quoteEnd('『', '』'),
    // A closing ’ is one not followed by a letter, so apostrophes inside the quote are kept.
    String.raw`‘[^\n]*?(?:’(?![\p{L}\p{N}\p{M}])|$)`,
    // A straight ' opens only at a word start and must close on its line, so elisions such as 'em survive.
    // Inside, ' may only sit between letters, so a failed attempt stops at the next opener and the scan stays linear.
    // The character before the opener is consumed instead of using a lookbehind; it only becomes part of the break.
    String.raw`(?:^|[^\p{L}\p{N}\p{M}])'(?=\p{L})(?:[\p{L}\p{N}\p{M}]'(?=[\p{L}\p{N}\p{M}])|[^'\n])*?'(?![\p{L}\p{N}\p{M}])`,
].join('|'), 'gimu');

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const cleanPhrase = value => typeof value === 'string'
    ? value.normalize('NFC').replace(/[*_~]/gu, '').replace(/\s+/gu, ' ').trim() : '';
const isWord = (token, set) => token?.type === 'word' && set.has(token.low);
const isAnd = token => token?.type === '&' || (token?.type === 'word' && token.low === 'and');
const isSplitter = token => isAnd(token) || isWord(token, SPLITTERS);
// "would've" is hedged by its first part.
const isHedge = low => HEDGES.has(low.split('\'')[0]) || table.hedgeEndings.some(ending => low.endsWith(ending));
const isActionWord = token => token?.type === 'ref'
    || (token?.type === 'word' && !isHedge(token.low) && !SUBORDINATE.has(token.low) && !SPLITTERS.has(token.low));
const isFiller = token => token?.type === 'word' || token?.type === 'ref';
const markType = char => {
    if (char === ',' || char === '&') return char;
    return QUOTE_MARK.test(char) ? 'quote' : 'other';
};

/**
 * Exact references for this call: full names, unique first words of multi-word
 * names and unique aliases. A phrase two members share, or the persona's full
 * name or first word, belongs to nobody. Members without a unique avatar never
 * resolve, but their phrases still block others.
 */
function buildReferences(members, persona) {
    const avatarCounts = new Map();
    const phrases = new Map();
    members.forEach((member, index) => {
        const avatar = typeof member?.avatar === 'string' ? member.avatar : '';
        if (avatar) avatarCounts.set(avatar, (avatarCounts.get(avatar) ?? 0) + 1);
        const name = cleanPhrase(member?.name);
        const nameWords = name.split(' ');
        const aliases = Array.isArray(member?.aliases) ? member.aliases.map(cleanPhrase) : [];
        for (const phrase of [name, nameWords.length > 1 ? nameWords[0] : '', ...aliases]) {
            if (!phrase) continue;
            const key = phrase.toLowerCase();
            const entry = phrases.get(key) ?? { owners: new Set(), forms: new Set() };
            entry.owners.add(index);
            entry.forms.add(phrase);
            phrases.set(key, entry);
        }
    });
    const self = cleanPhrase(persona);
    const blocked = new Set([self, self.split(' ')[0]].filter(Boolean).map(phrase => phrase.toLowerCase()));
    const unique = new Set([...avatarCounts].filter(([, count]) => count === 1).map(([avatar]) => avatar));
    const references = [];
    for (const [key, { owners, forms }] of phrases) {
        if (owners.size !== 1 || blocked.has(key)) continue;
        const avatar = members[[...owners][0]]?.avatar;
        if (!unique.has(avatar)) continue;
        for (const phrase of forms) {
            const first = phrase.codePointAt(0);
            if (!WORD_CHAR.test(String.fromCodePoint(first))) continue;
            const body = phrase.split(' ').map(escapeRegex).join('[^\\S\\n]+');
            references.push({ avatar, first, length: phrase.length, pattern: new RegExp(`${body}(?!${BOUNDARY})`, 'iuy') });
        }
    }
    references.sort((left, right) => right.length - left.length);
    return { references, unique };
}

/** Leftmost-longest reference occurrences; the first letter must match the name's case. */
function findReferences(text, references) {
    const found = [];
    WORD_RUN.lastIndex = 0;
    for (let run = WORD_RUN.exec(text); run; run = WORD_RUN.exec(text)) {
        const start = run.index;
        const first = text.codePointAt(start);
        const reference = references.find(candidate => {
            if (candidate.first !== first) return false;
            candidate.pattern.lastIndex = start;
            return candidate.pattern.test(text);
        });
        if (!reference) continue;
        let end = reference.pattern.lastIndex;
        POSSESSIVE.lastIndex = end;
        const possessive = POSSESSIVE.test(text);
        if (possessive) end = POSSESSIVE.lastIndex;
        found.push({ avatar: reference.avatar, possessive, start, end });
        WORD_RUN.lastIndex = end;
    }
    return found;
}

/**
 * Hard sentence segments; a break inside a name such as "Dr. Watson" is not a break.
 * `first` is the index of the segment's first reference, so tokenizing stays linear.
 */
function segments(text, found) {
    const result = [];
    let start = 0;
    let first = 0;
    let index = 0;
    for (const match of text.matchAll(BREAK)) {
        while (found[index] && found[index].end <= match.index) index++;
        if (found[index] && found[index].start <= match.index) continue;
        result.push({ start, end: match.index, question: match[0].includes('?'), first });
        start = match.index + match[0].length;
        first = index;
    }
    result.push({ start, end: text.length, question: false, first });
    return result;
}

function tokenize(text, { start, end, first }, found) {
    const tokens = [];
    let index = first;
    let at = start;
    while (at < end) {
        const char = String.fromCodePoint(text.codePointAt(at));
        if (SPACE.test(char)) {
            at += char.length;
            continue;
        }
        while (found[index] && found[index].start < at) index++;
        const reference = found[index];
        let token;
        if (reference?.start === at) {
            token = { type: 'ref', avatar: reference.avatar, possessive: reference.possessive, start: at, end: reference.end };
        } else {
            WORD.lastIndex = at;
            const word = WORD.exec(text);
            if (word) {
                const stop = Math.min(at + word[0].length, end, reference?.start ?? end);
                const raw = text.slice(at, stop);
                token = { type: 'word', raw, low: raw.toLowerCase().replaceAll('’', '\''), start: at, end: stop };
            } else {
                token = { type: markType(char), start: at, end: at + char.length };
            }
        }
        tokens.push(token);
        at = token.end;
    }
    return tokens;
}

// A quote mark is not junk: one left after the hiding pass belongs to dialogue it could not pair.
function skipJunk(tokens, at) {
    let next = at;
    while (tokens[next]?.type === 'other' || tokens[next]?.type === ',') next++;
    return next;
}

function skipLead(tokens, at) {
    for (const lead of LEADS) {
        if (!lead.every((word, offset) => tokens[at + offset]?.type === 'word' && tokens[at + offset].low === word)) continue;
        const next = at + lead.length;
        return tokens[next]?.type === ',' ? next + 1 : next;
    }
    return at;
}

/**
 * A leading list of member references joined by ",", "and", "&" or ", and".
 * `joined` is false when the last joint is a bare comma: "Alice, Bob left" is a vocative, not a list.
 */
function readMembers(tokens, at) {
    const refs = [];
    if (tokens[at]?.type !== 'ref') return { refs, next: at, joined: false };
    refs.push(tokens[at]);
    let next = at + 1;
    let joined = true;
    for (;;) {
        let joint = next;
        if (tokens[joint]?.type === ',') joint++;
        const and = isAnd(tokens[joint]);
        if (and) joint++;
        if (joint === next || tokens[joint]?.type !== 'ref') break;
        refs.push(tokens[joint]);
        joined = and;
        next = joint + 1;
    }
    return { refs, next, joined };
}

/** Split at "and", "but" or "then" before a member reference, outside a leading subject list. */
function splitClauses(tokens) {
    const clauses = [];
    let start = 0;
    for (let at = readMembers(tokens, skipLead(tokens, skipJunk(tokens, 0))).next; at < tokens.length - 1; at++) {
        // From a subordinator, question word or "that" on, a coordinated clause may be embedded too.
        if (isWord(tokens[at], EMBEDDING)) break;
        // After a reference the splitter continues a list: "watched as Bob and Carol left".
        if (!isSplitter(tokens[at]) || tokens[at + 1].type !== 'ref' || tokens[at - 1]?.type === 'ref') continue;
        clauses.push(tokens.slice(start, at));
        start = at + 1;
        at = readMembers(tokens, start).next - 1;
    }
    clauses.push(tokens.slice(start));
    return clauses;
}

function closes(tokens, at) {
    const token = tokens[at];
    return !token || token.type === ',' || isAnd(token) || isWord(token, CLOSERS)
        || tokens.slice(at).every(rest => rest.type === 'other');
}

function wordsAt(tokens, at, phrase) {
    return phrase.every((word, offset) => tokens[at + offset]?.type === 'word' && tokens[at + offset].low === word)
        ? at + phrase.length : -1;
}

/** Ends after one or two words starting at `at`, the object of a preposition. */
function objectEnds(tokens, at) {
    if (at < 0 || !isFiller(tokens[at])) return [];
    return isFiller(tokens[at + 1]) ? [at + 1, at + 2] : [at + 1];
}

const lastClosing = (tokens, ends) => Math.max(-1, ...ends.filter(end => end >= 0 && closes(tokens, end)));

/** Index where the clause may end after an optional tail, or -1. */
function readTail(tokens, at) {
    const ends = [at];
    const token = tokens[at];
    if (token?.type === 'word') {
        if (TAILS.has(token.low)) ends.push(at + 1);
        for (const phrase of DOOR_TAILS) ends.push(wordsAt(tokens, at, phrase));
        if (ARTICLES.has(token.low) && isWord(tokens[at + 1], PLACES)) ends.push(at + 2);
        if (PREPOSITIONS.has(token.low)) ends.push(...objectEnds(tokens, at + 1));
    }
    return lastClosing(tokens, ends);
}

function readComplement(tokens, at, entry) {
    const phrased = lastClosing(tokens,
        (entry.phrases ?? []).flatMap(phrase => objectEnds(tokens, wordsAt(tokens, at, phrase))));
    let next = at;
    if (entry.particles) {
        if (tokens[next]?.type !== 'word' || !entry.particles.includes(tokens[next].low)) return phrased;
        next++;
    } else if (entry.objects) {
        next = Math.max(-1, ...entry.objects.map(phrase => wordsAt(tokens, next, phrase)));
        if (next < 0) return phrased;
    }
    return Math.max(phrased, readTail(tokens, next));
}

/** After "is", "has" or a contracted "'s": a state word or a participle. Returns the new status or null. */
function readAfterAux(tokens, at, aux) {
    const token = tokens[at];
    if (token?.type !== 'word') return null;
    if (aux !== 'perfect') {
        const state = STATES.find(entry => entry.particles.includes(token.low) && readTail(tokens, at + 1) >= 0);
        if (state) return state.to;
    }
    if (aux !== 'be') {
        const verb = VERBS.find(entry => table.forms[entry.verb][PARTICIPLE] === token.low && readComplement(tokens, at + 1, entry) >= 0);
        if (verb) return verb.to;
    }
    return null;
}

function readVerb(tokens, at, number) {
    const token = tokens[at];
    if (token?.type !== 'word') return null;
    if (number !== 'bare' && table.perfect[number].includes(token.low)) return readAfterAux(tokens, at + 1, 'perfect');
    if (number !== 'bare' && table.be[number].includes(token.low)) return readAfterAux(tokens, at + 1, 'be');
    const verb = VERBS.find(entry => SLOTS[number].some(slot => table.forms[entry.verb][slot] === token.low)
        && readComplement(tokens, at + 1, entry) >= 0);
    return verb ? verb.to : null;
}

function readSubject(tokens, at, author, direct) {
    const token = tokens[at];
    if (token?.type === 'ref') {
        const { refs, next, joined } = readMembers(tokens, at);
        if (!joined || refs.length > 4) return null;
        if (refs.some(ref => ref.possessive)) {
            return refs.length === 1 ? { who: refs, number: 'one', aux: 'contracted', next } : null;
        }
        return { who: refs, number: refs.length > 1 ? 'many' : 'one', aux: '', next };
    }
    if (token?.type !== 'word' || !author) return null;
    const who = [{ avatar: author, start: token.start }];
    const raw = token.raw.replaceAll('’', '\'');
    const form = Object.keys(table.firstPerson).find(key => table.firstPerson[key].includes(raw));
    if (form) return { who, number: 'self', aux: form === 'plain' ? '' : form, next: at + 1 };
    // Only a clause that opens directly on a verb is the author's own move; a lead or anything else first is not.
    return direct ? { who, number: 'bare', aux: '', next: at } : null;
}

function readPredicate(tokens, { number, aux, next }) {
    if (aux) return readAfterAux(tokens, next, aux);
    if (number === 'bare') return readVerb(tokens, next, number);
    let at = next;
    const adverb = tokens[at];
    if (adverb?.type === 'word' && /^\p{Ll}/u.test(adverb.raw) && adverb.low.length > 3 && adverb.low.endsWith('ly')) {
        if (HEDGES.has(adverb.low)) return null;
        at++;
    }
    for (let size = 1; size <= 4 && isActionWord(tokens[at + size - 1]); size++) {
        if (!isAnd(tokens[at + size])) continue;
        const verb = readVerb(tokens, at + size + 1, number);
        if (verb) return verb;
    }
    return readVerb(tokens, at, number);
}

/** `[lead] SUBJECT [adverb] [ACTION and] VERB [tail] (end | , | and | but | as | while | with)` */
function readClause(tokens, author) {
    const first = skipJunk(tokens, 0);
    const at = skipLead(tokens, first);
    const subject = readSubject(tokens, at, author, at === first);
    if (!subject) return null;
    const to = readPredicate(tokens, subject);
    return to && { to, who: subject.who };
}

/**
 * Read arrivals and departures of the open scene's members from one new line.
 * Returns one entry per member, the last mention winning, ordered by that mention.
 */
export function detectPresence(text, { members = [], persona = '', author, kind } = {}) {
    if (typeof text !== 'string' || !text || !Array.isArray(members)) return [];
    const { references, unique } = buildReferences(members, persona);
    const writer = kind === 'character' && typeof author === 'string' && unique.has(author) ? author : '';
    const plain = text.normalize('NFC').replace(HIDDEN, '\n').replace(EMPHASIS, '');
    const found = findReferences(plain, references);
    const events = [];
    for (const segment of segments(plain, found)) {
        if (segment.question) continue;
        for (const clause of splitClauses(tokenize(plain, segment, found))) {
            const result = readClause(clause, writer);
            if (result) for (const { avatar, start } of result.who) events.push({ avatar, to: result.to, at: start });
        }
    }
    events.sort((left, right) => left.at - right.at);
    const latest = new Map();
    for (const event of events) {
        latest.delete(event.avatar);
        latest.set(event.avatar, event.to);
    }
    return [...latest].map(([avatar, to]) => ({ avatar, to }));
}
