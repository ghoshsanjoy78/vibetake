// whisper-1 returns bare tokens (`Okay`, `so`, `I'm`) while its `text` is punctuated. Walk `text`
// once, in order, and hand each word the punctuation that follows it there, so `said` reads as
// sentences. A word that cannot be found at a word boundary from the cursor on keeps its bare form
// and the cursor stays put: nothing is invented, and one miss does not derail the words after it.
const TRAILING = /^[.,!?;:\u2026"'\u2018\u2019\u201C\u201D)\]]+/;
const WORDISH = /[\p{L}\p{N}]/u;
const boundaryIndex = (haystack, needle, from) => {
    let at = haystack.indexOf(needle, from);
    while (at !== -1) {
        const before = at === 0 ? "" : haystack[at - 1];
        const after = haystack[at + needle.length] ?? "";
        if (!WORDISH.test(before) && !WORDISH.test(after))
            return at;
        at = haystack.indexOf(needle, at + 1);
    }
    return -1;
};
export const attachPunctuation = (words, text) => {
    const lower = text.toLowerCase();
    let cursor = 0;
    return words.map(w => {
        const bare = w.word.trim();
        if (bare === "")
            return w;
        const at = boundaryIndex(lower, bare.toLowerCase(), cursor);
        if (at === -1)
            return { ...w, word: bare };
        const punct = TRAILING.exec(text.slice(at + bare.length))?.[0] ?? "";
        cursor = at + bare.length + punct.length;
        return { ...w, word: bare + punct };
    });
};
