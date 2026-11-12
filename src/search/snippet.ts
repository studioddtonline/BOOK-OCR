const SNIPPET_MARGIN = 20;

/**
 * FTS5のsnippet()相当のものを手作りする。candidatesの中から実際に本文に
 * 含まれる最初の語を使ってハイライトする(複合クエリでは複数の語が
 * 候補になり得るため、配列で受け取る)。
 */
export function buildSnippet(text: string, candidates: string[]): string {
  for (const term of candidates) {
    const idx = text.indexOf(term);
    if (idx === -1) continue;

    const start = Math.max(0, idx - SNIPPET_MARGIN);
    const end = Math.min(text.length, idx + term.length + SNIPPET_MARGIN);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < text.length ? "..." : "";

    return prefix + text.slice(start, idx) + "[" + term + "]" + text.slice(idx + term.length, end) + suffix;
  }
  // どの候補語も本文中に見つからなかった場合(例: NOTだけで構成されたクエリ)
  return text.slice(0, 60) + (text.length > 60 ? "..." : "");
}
