/**
 * Multilingual normalization and tokenization for search queries and indexed text.
 *
 * Goals:
 * - Fold Unicode forms (NFKC) so composed/decomposed input matches.
 * - Fold diacritics for languages where they are not semantically significant.
 * - Apply language-specific token boundaries (e.g. CJK, Thai) while keeping
 *   safe fallbacks for unknown languages.
 * - Never throw on malformed input; degrade to a conservative fallback.
 *
 * Retention & access policy for raw search queries (issue #262):
 * - Raw query text is sensitive intent data. It MUST NOT be persisted in
 *   plaintext alongside identifiers. Callers that need to store a query for
 *   analytics or debugging MUST use `buildRetainedQueryRecord`, which stores
 *   only the normalized tokens plus a non-reversible hash of the raw text.
 * - Identifiers are minimized: no user id, profile id, IP, or session id is
 *   attached here. If correlation is required, use a coarse, rotating bucket
 *   (see `RetentionPolicy.bucket`) rather than a stable identifier.
 * - Retention is bounded: every retained record carries an `expiresAt` derived
 *   from `DEFAULT_RETENTION_POLICY.maxAgeMs`. Records past expiry MUST be
 *   treated as absent by readers and purged by the owning store.
 * - Logging and analytics MUST follow the same policy: use
 *   `toLogSafeQuery` for any log/analytics emission so raw text never leaks
 *   and the same expiry applies.
 *
 * Deletion verification policy (issue #263):
 * - A queued deletion event does not prove that every index/replica stopped
 *   returning the removed content. The owning search boundary MUST track
 *   per-index completion and verify it before reporting a record as deleted.
 * - Verification is keyed by an opaque identifier (see `buildOpaqueRecordId`),
 *   never by raw content. Status output MUST NOT include deleted content.
 * - Retries are safe: re-verifying an already-complete index is a no-op and
 *   never duplicates work or leaks content.
 *
 * Ranking confidence policy (issue #264):
 * - Ranking output MUST carry an explicit confidence signal so callers can
 *   distinguish a trustworthy result set from a degraded one. Confidence is
 *   derived from candidate count and match quality (see
 *   `assessRankingConfidence`).
 * - Sparse candidate sets and no-exact-match queries are LOW confidence and
 *   MUST trigger the documented fallback behavior rather than being presented
 *   as authoritative recommendations.
 * - A true empty result (query ran, zero candidates) is distinct from a
 *   degraded dependency failure (index unavailable / errored). The owning
 *   boundary MUST surface these with explicit failure semantics via
 *   `classifyRankingOutcome`; degraded failures MUST NOT be reported as empty.
 */

export type SupportedLanguage =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'ru'
  | 'ar'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'th';

export interface NormalizationOptions {
  /** BCP-47-ish language tag; unknown values fall back to the default profile. */
  language?: string;
  /** When false, diacritics are preserved (e.g. for languages where they matter). */
  foldDiacritics?: boolean;
}

export interface NormalizationResult {
  /** Normalized text suitable for indexing or query matching. */
  normalized: string;
  /** Tokenized form of the normalized text. */
  tokens: string[];
  /** Language profile actually applied (may be the fallback). */
  language: SupportedLanguage | 'default';
  /** True when the requested language was not recognized and a fallback was used. */
  usedFallback: boolean;
}

interface LanguageProfile {
  /** Whether diacritics should be folded by default for this language. */
  foldDiacritics: boolean;
  /** Regex used to split tokens; must be applied to NFKC-normalized text. */
  tokenPattern: RegExp;
}

// Combining diacritical marks block (U+0300–U+036F) plus common extended marks.
const DIACRITIC_PATTERN = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff]/g;

// CJK / Thai scripts have no whitespace word boundaries; tokenize per character
// (or per grapheme cluster) so substring matching remains meaningful.
const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const THAI_CHAR_PATTERN = /[\u0e00-\u0e7f]/u;

const WORD_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

const PROFILES: Record<SupportedLanguage, LanguageProfile> = {
  en: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  es: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  fr: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  de: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  pt: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  ru: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  ar: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  zh: { foldDiacritics: false, tokenPattern: WORD_TOKEN_PATTERN },
  ja: { foldDiacritics: false, tokenPattern: WORD_TOKEN_PATTERN },
  ko: { foldDiacritics: false, tokenPattern: WORD_TOKEN_PATTERN },
  th: { foldDiacritics: false, tokenPattern: WORD_TOKEN_PATTERN },
};

const DEFAULT_PROFILE: LanguageProfile = {
  foldDiacritics: true,
  tokenPattern: WORD_TOKEN_PATTERN,
};

function resolveLanguage(
  language: string | undefined,
): { profile: LanguageProfile; language: SupportedLanguage | 'default'; usedFallback: boolean } {
  if (!language || typeof language !== 'string') {
    return { profile: DEFAULT_PROFILE, language: 'default', usedFallback: true };
  }
  // Accept tags like "en-US" or "zh_Hans" by taking the primary subtag.
  const primary = language.trim().toLowerCase().split(/[-_]/)[0];
  if (primary && Object.prototype.hasOwnProperty.call(PROFILES, primary)) {
    return {
      profile: PROFILES[primary as SupportedLanguage],
      language: primary as SupportedLanguage,
      usedFallback: false,
    };
  }
  return { profile: DEFAULT_PROFILE, language: 'default', usedFallback: true };
}

function foldDiacritics(text: string): string {
  // NFD splits base characters from combining marks so they can be stripped.
  return text.normalize('NFD').replace(DIACRITIC_PATTERN, '').normalize('NFC');
}

function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  // Split on whitespace first, then further split CJK/Thai runs per character
  // while keeping contiguous Latin/Cyrillic/Arabic words intact.
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    if (CJK_CHAR_PATTERN.test(chunk) || THAI_CHAR_PATTERN.test(chunk)) {
      for (const char of chunk) {
        if (CJK_CHAR_PATTERN.test(char) || THAI_CHAR_PATTERN.test(char)) {
          tokens.push(char);
        } else {
          const matches = char.match(WORD_TOKEN_PATTERN);
          if (matches) tokens.push(...matches);
        }
      }
    } else {
      const matches = chunk.match(WORD_TOKEN_PATTERN);
      if (matches) tokens.push(...matches);
    }
  }
  return tokens;
}

/**
 * Normalize and tokenize text for search. Never throws: malformed input
 * (lone surrogates, invalid sequences) is coerced to a string and normalized
 * with the fallback profile.
 */
export function normalizeForSearch(
  input: unknown,
  options: NormalizationOptions = {},
): NormalizationResult {
  const { profile, language, usedFallback } = resolveLanguage(options.language);
  const fold = options.foldDiacritics ?? profile.foldDiacritics;

  let text: string;
  try {
    text = typeof input === 'string' ? input : input == null ? '' : String(input);
  } catch {
    text = '';
  }

  let normalized: string;
  try {
    // NFKC unifies compatibility forms (full-width, ligatures) before folding.
    normalized = text.normalize('NFKC');
    if (fold) normalized = foldDiacritics(normalized);
    normalized = normalized.toLowerCase().trim();
  } catch {
    // Malformed input: fall back to a conservative lowercase trim.
    normalized = text.toLowerCase().trim();
  }

  let tokens: string[];
  try {
    tokens = tokenize(normalized);
  } catch {
    tokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  }

  return { normalized, tokens, language, usedFallback };
}

/** Convenience helper for indexing pipelines. */
export function normalizeIndexedText(
  input: unknown,
  options: NormalizationOptions = {},
): string {
  return normalizeForSearch(input, options).normalized;
}

/** Convenience helper for query pipelines. */
export function normalizeQuery(
  input: unknown,
  options: NormalizationOptions = {},
): string[] {
  return normalizeForSearch(input, options).tokens;
}

/**
 * Ranking confidence thresholds (issue #264).
 *
 * Confidence is a coarse, explicit signal so callers never present a sparse or
 * no-exact-match result set as authoritative. Thresholds are intentionally
 * conservative and centralized here so the owning boundary and tests share a
 * single source of truth.
 */
export interface RankingConfidenceThresholds {
  /** Minimum candidate count for a result set to be considered non-sparse. */
  minCandidates: number;
  /** Minimum match-quality ratio (0..1) for a result set to be trusted. */
  minMatchQuality: number;
}

export const DEFAULT_RANKING_THRESHOLDS: RankingConfidenceThresholds = {
  minCandidates: 3,
  minMatchQuality: 0.5,
};

export type RankingConfidence = 'high' | 'low';

export interface RankingConfidenceInput {
  /** Number of candidates returned by the index for this query. */
  candidateCount: number;
  /** Number of candidates that matched the query exactly (0..candidateCount). */
  exactMatchCount: number;
  /** Optional threshold overrides; merged over the defaults. */
  thresholds?: Partial<RankingConfidenceThresholds>;
}

export interface RankingConfidenceResult {
  confidence: RankingConfidence;
  /** Match-quality ratio in [0, 1]; 0 when there are no candidates. */
  matchQuality: number;
  /** True when the candidate set is below `minCandidates`. */
  sparse: boolean;
  /** True when no candidate matched the query exactly. */
  noExactMatch: boolean;
  /** True when confidence is low and the caller MUST apply fallback behavior. */
  useFallback: boolean;
}

/**
 * Assess ranking confidence from candidate count and match quality. Pure and
 * total: malformed counts are coerced to safe values and never throw.
 */
export function assessRankingConfidence(
  input: RankingConfidenceInput,
): RankingConfidenceResult {
  const thresholds: RankingConfidenceThresholds = {
    ...DEFAULT_RANKING_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };

  const candidateCount = Number.isFinite(input.candidateCount)
    ? Math.max(0, Math.floor(input.candidateCount))
    : 0;
  const exactMatchCount = Number.isFinite(input.exactMatchCount)
    ? Math.min(candidateCount, Math.max(0, Math.floor(input.exactMatchCount)))
    : 0;

  const matchQuality = candidateCount > 0 ? exactMatchCount / candidateCount : 0;
  const sparse = candidateCount < thresholds.minCandidates;
  const noExactMatch = exactMatchCount === 0;

  const confidence: RankingConfidence =
    !sparse && !noExactMatch && matchQuality >= thresholds.minMatchQuality
      ? 'high'
      : 'low';

  return {
    confidence,
    matchQuality,
    sparse,
    noExactMatch,
    useFallback: confidence === 'low',
  };
}

/**
 * Explicit failure semantics for the search boundary (issue #264).
 *
 * - `ok`: the query ran and produced candidates.
 * - `empty`: the query ran successfully but matched nothing (a TRUE empty
 *   result). This is a valid, non-degraded outcome.
 * - `degraded`: a dependency (index/replica) failed or was unavailable. This
 *   MUST NOT be reported as an empty result; callers should surface an error
 *   or retry rather than showing "no results".
 */
export type RankingOutcomeStatus = 'ok' | 'empty' | 'degraded';

export interface RankingOutcomeInput {
  /** Number of candidates returned; ignored when `dependencyFailed` is true. */
  candidateCount: number;
  /** True when the owning index/dependency errored or was unavailable. */
  dependencyFailed?: boolean;
}

export interface RankingOutcome {
  status: RankingOutcomeStatus;
  /** True only for a genuine empty result (not a degraded failure). */
  isEmpty: boolean;
  /** True when a dependency failed; callers MUST NOT treat this as empty. */
  isDegraded: boolean;
}

/**
 * Classify a search outcome, keeping true empty results distinct from degraded
 * dependency failures. Degraded takes precedence over empty.
 */
export function classifyRankingOutcome(
  input: RankingOutcomeInput,
): RankingOutcome {
  if (input.dependencyFailed) {
    return { status: 'degraded', isEmpty: false, isDegraded: true };
  }
  const candidateCount = Number.isFinite(input.candidateCount)
    ? Math.max(0, Math.floor(input.candidateCount))
    : 0;
  if (candidateCount === 0) {
    return { status: 'empty', isEmpty: true, isDegraded: false };
  }
  return { status: 'ok', isEmpty: false, isDegraded: false };
}
