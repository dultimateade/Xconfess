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
 * Retention policy for raw search queries. All stored/emitted query data MUST
 * be bounded by `maxAgeMs`; there is no unbounded retention path.
 */
export interface RetentionPolicy {
  /** Maximum age in milliseconds a retained query record may live. */
  maxAgeMs: number;
  /** Coarse, rotating correlation bucket (e.g. "2024-06-01") — never a stable id. */
  bucket?: string;
}

/** Default bounded retention window: 30 days. */
export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = Object.freeze({
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

/**
 * A minimized, bounded record of a raw search query. Contains no raw text and
 * no stable identifiers — only normalized tokens, a non-reversible hash, and
 * an explicit expiry.
 */
export interface RetainedQueryRecord {
  /** Normalized tokens (already lowercased/folded); safe for analytics. */
  tokens: string[];
  /** Non-reversible hash of the raw query text (hex). */
  queryHash: string;
  /** Language profile applied. */
  language: SupportedLanguage | 'default';
  /** Epoch ms after which this record MUST be treated as absent. */
  expiresAt: number;
  /** Optional coarse correlation bucket; never a stable identifier. */
  bucket?: string;
}

/**
 * Deterministic, non-reversible 32-bit FNV-1a hash rendered as hex. This is
 * intentionally not cryptographic — it exists only to dedupe/group identical
 * queries without retaining the raw text. Do not use for security decisions.
 */
function hashQuery(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a minimized, bounded record for a raw search query. This is the ONLY
 * sanctioned way to persist query data: raw text is hashed and discarded, and
 * an explicit `expiresAt` is attached from the retention policy.
 */
export function buildRetainedQueryRecord(
  input: unknown,
  options: NormalizationOptions = {},
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: number = Date.now(),
): RetainedQueryRecord {
  const result = normalizeForSearch(input, options);
  const raw = typeof input === 'string' ? input : input == null ? '' : String(input);
  const maxAgeMs = Number.isFinite(policy.maxAgeMs) && policy.maxAgeMs > 0
    ? policy.maxAgeMs
    : DEFAULT_RETENTION_POLICY.maxAgeMs;
  const record: RetainedQueryRecord = {
    tokens: result.tokens,
    queryHash: hashQuery(raw),
    language: result.language,
    expiresAt: now + maxAgeMs,
  };
  if (policy.bucket) record.bucket = policy.bucket;
  return record;
}

/**
 * Returns true when a retained record is still within its retention window.
 * Readers MUST call this before using a record; expired records are absent.
 */
export function isRetainedQueryLive(
  record: RetainedQueryRecord,
  now: number = Date.now(),
): boolean {
  return Number.isFinite(record.expiresAt) && record.expiresAt > now;
}

/**
 * Log/analytics-safe projection of a query. Emits only the hash, token count,
 * language, and expiry — never raw text or tokens that could reconstruct intent
 * verbatim. Logging and analytics MUST use this instead of raw query strings.
 */
export interface LogSafeQuery {
  queryHash: string;
  tokenCount: number;
  language: SupportedLanguage | 'default';
  expiresAt: number;
  bucket?: string;
}

export function toLogSafeQuery(record: RetainedQueryRecord): LogSafeQuery {
  const safe: LogSafeQuery = {
    queryHash: record.queryHash,
    tokenCount: record.tokens.length,
    language: record.language,
    expiresAt: record.expiresAt,
  };
  if (record.bucket) safe.bucket = record.bucket;
  return safe;
}
