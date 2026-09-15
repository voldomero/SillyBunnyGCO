const NUMBER = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const HEIGHT_PATTERN = new RegExp(
    `(?<![\\w.,/+−-])(?<sign>[+−-]?)\\s*(?<value>${NUMBER})\\s*(?:(?<feet>feet\\b|foot\\b|ft\\b|['’′])(?:\\s*(?:and\\s+)?(?<inchSign>[+−-]?)\\s*(?<inches>${NUMBER})\\s*(?:inches\\b|inch\\b|inc\\b|in\\b|["”″]))?|(?<unit>kilomet(?:er|re)s?\\b|km\\b|centimet(?:er|re)s?\\b|cm\\b|millimet(?:er|re)s?\\b|mm\\b|met(?:er|re)s?\\b|m\\b|inches\\b|inch\\b|inc\\b|in\\b|["”″]))`,
    'i',
);

export function parseHeight(description) {
    if (typeof description !== 'string') return null;
    const match = HEIGHT_PATTERN.exec(description);
    if (!match) return null;

    const { sign, value, feet, inchSign, inches, unit } = match.groups;
    if (sign === '-' || sign === '−' || inchSign === '-' || inchSign === '−') return null;
    let height = Number(value);
    if (feet) {
        height = height * 12 + Number(inches ?? 0);
    } else {
        const measurement = unit.toLowerCase();
        if (measurement.startsWith('km') || measurement.startsWith('kilo')) height *= 100000 / 2.54;
        else if (measurement.startsWith('cm') || measurement.startsWith('centi')) height /= 2.54;
        else if (measurement.startsWith('mm') || measurement.startsWith('milli')) height /= 25.4;
        else if (measurement.startsWith('m')) height *= 100 / 2.54;
    }
    return Number.isFinite(height) && height > 0 ? height : null;
}

export function compareHeights(speakerHeight, memberHeight) {
    if (![speakerHeight, memberHeight].every(height => Number.isFinite(height) && height > 0)) return null;
    // Equivalent metric and imperial measurements can differ by floating-point rounding.
    if (Math.abs(speakerHeight - memberHeight) < 1e-6) return 'equal';
    if (speakerHeight <= memberHeight / 2) return 'much-shorter';
    if (speakerHeight >= memberHeight * 2) return 'much-taller';
    return speakerHeight < memberHeight ? 'shorter' : 'taller';
}

function heightDifference(a, b) {
    const difference = Math.abs(a - b);
    return difference < 12
        ? `A ${Number(difference.toFixed(2))} inch height difference.`
        : `A ${(difference / 12).toFixed(2)}ft height difference.`;
}

export async function onRearrangeChat({ generatingCharacter, members = [] } = {}) {
    const generatingHeight = parseHeight(generatingCharacter?.description);
    if (generatingHeight === null || !Array.isArray(members)) return [];

    const notes = [];
    for (const character of members) {
        if (!character || character === generatingCharacter
            || (character.avatar && character.avatar === generatingCharacter.avatar)) continue;
        const height = parseHeight(character.description);
        const comparison = compareHeights(generatingHeight, height);
        if (!comparison) continue;

        const directions = {
            equal: 'is same height as',
            'much-shorter': 'must lean back and look up at',
            'much-taller': 'must look and lean down at',
            shorter: 'must look up at',
            taller: 'must look down at',
        };
        const difference = comparison === 'equal' ? '' : ` ${heightDifference(generatingHeight, height)}`;
        notes.push(`[System Note: ${generatingCharacter.name} ${directions[comparison]} ${character.name}.${difference}]`);
    }
    return notes;
}
