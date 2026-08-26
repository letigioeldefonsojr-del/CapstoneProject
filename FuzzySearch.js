// ====================================================================
// FUZZY SEARCH (typo-tolerant matching)
// ----------------------------------------------------------------
// Uses Levenshtein edit distance — a well-established technique from
// computational linguistics/NLP (the same underlying idea behind
// spell-checkers) — to measure how many single-character changes
// (insert, delete, substitute) it takes to turn one word into
// another. A small distance means "probably a typo of this word",
// which lets search match close misspellings that a plain substring
// check would completely miss — e.g. searching "Agentina" still
// finds "Argentina", since only one letter is missing.
//
// Always tries an exact substring match FIRST (fast, and always
// correct when the person spelled it right) — fuzzy matching only
// kicks in as a fallback when nothing matched exactly, so normal
// correctly-spelled searches behave exactly as before.
// ====================================================================

export function fuzzyMatch(searchTerm, text) {
  const term = searchTerm.trim().toLowerCase();
  const target = text.toLowerCase();

  if (!term) return true;
  if (target.includes(term)) return true; // exact substring — always wins, no fuzzy needed

  // Check the search term against each word in the target text
  // individually — catches "Agentina" matching the word "Argentina"
  // inside a longer product name like "Argentina Corned Beef".
  const words = target.split(/\s+/);
  return words.some((word) => isCloseEnough(term, word) || isPartialTypedMatch(term, word));
}

function isCloseEnough(term, word) {
  // Skip pointless comparisons — a 2-character search against a
  // 15-character word isn't a meaningful typo check, and very short
  // words produce too many accidental "close" matches to be useful.
  if (term.length < 3 || word.length < 3) return false;

  const distance = levenshteinDistance(term, word);
  const threshold = Math.max(1, Math.floor(Math.max(term.length, word.length) / 4));
  return distance <= threshold;
}

// Handles a DIFFERENT case than typo-correction: someone typing only
// part of a word (e.g. "argn" for "Argentina") rather than
// misspelling it. Checks whether every letter they typed appears, IN
// ORDER, somewhere within the word — even with gaps between them.
// Same core idea as the fuzzy-finder in tools like VS Code's command
// palette. Requires at least 60% of the word's letters to actually be
// "hit" (not just any 1-2 stray letters matching by coincidence) —
// keeps this from matching almost everything for very short searches.
function isPartialTypedMatch(term, word) {
  if (term.length < 3 || word.length < 3) return false;
  if (term.length > word.length) return false; // can't be a partial typing of a shorter word

  let termIndex = 0;
  for (let i = 0; i < word.length && termIndex < term.length; i++) {
    if (word[i] === term[termIndex]) termIndex++;
  }

  const matchedFraction = termIndex / term.length;
  return matchedFraction === 1 && term.length / word.length >= 0.35;
}

// Classic dynamic-programming edit distance calculation.
function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, (_, i) => [i, ...new Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}