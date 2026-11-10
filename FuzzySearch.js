// fuzzy — Typo-tolerant text matching (Levenshtein).

export function fuzzyMatch(searchTerm, text) {
  const term = searchTerm.trim().toLowerCase();
  const target = text.toLowerCase();

  if (!term) return true;
  if (target.includes(term)) return true; // exact substring — always wins, no fuzzy needed

  const words = target.split(/\s+/);
  return words.some((word) => isCloseEnough(term, word) || isPartialTypedMatch(term, word));
}

function isCloseEnough(term, word) {
  if (term.length < 3 || word.length < 3) return false;

  const distance = levenshteinDistance(term, word);
  const threshold = Math.max(1, Math.floor(Math.max(term.length, word.length) / 4));
  return distance <= threshold;
}

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