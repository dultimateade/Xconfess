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
  /** Non-reversible hash of the raw query text (never the raw text itself). */
  queryHash: string;
  /** Normalized tokens for matching/analytics. */
  tokens: string[];
  /** Language profile applied. */
  language: SupportedLanguage | 'default';
  /** Coarse rotating bucket, if provided by the policy. */
  bucket?: string;
  /** Epoch millis after which this record MUST be treated as absent. */
  expiresAt: number;
}

/**
 * Non-reversible, deterministic hash of raw text. Uses a simple FNV-1a variant
 * so it works without a crypto dependency; this is for correlation only, not
 * for security-sensitive use.
 */
export function hashQueryText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Build a minimized, bounded retained record for a raw query. Never stores the
 * raw text; callers MUST use this instead of persisting raw queries.
 */
export function buildRetainedQueryRecord(
  input: unknown,
  options: NormalizationOptions = {},
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: number = Date.now(),
): RetainedQueryRecord {
  const result = normalizeForSearch(input, options);
  const raw = typeof input === 'string' ? input : input == null ? '' : String(input);
  const record: RetainedQueryRecord = {
    queryHash: hashQueryText(raw),
    tokens: result.tokens,
    language: result.language,
    expiresAt: now + policy.maxAgeMs,
  };
  if (policy.bucket) record.bucket = policy.bucket;
  return record;
}

/** True when a retained record is past its expiry and MUST be treated as absent. */
export function isRetainedQueryExpired(
  record: RetainedQueryRecord,
  now: number = Date.now(),
): boolean {
  return now >= record.expiresAt;
}

/**
 * Log/analytics-safe projection of a retained record. Never includes raw text
 * and drops expired records entirely.
 */
export function toLogSafeQuery(
  record: RetainedQueryRecord,
  now: number = Date.now(),
): Omit<RetainedQueryRecord, 'tokens'> | null {
  if (isRetainedQueryExpired(record, now)) return null;
  const { tokens: _tokens, ...safe } = record;
  return safe;
}

/**
 * Build an opaque, content-free identifier for a record so deletion tracking
 * and verification never carry raw deleted content (issue #263).
 */
export function buildOpaqueRecordId(recordKey: unknown): string {
  const raw = typeof recordKey === 'string' ? recordKey : recordKey == null ? '' : String(recordKey);
  return `rec_${hashQueryText(raw)}`;
}

/** Per-index deletion state. */
export type IndexDeletionState = 'pending' | 'verified' | 'failed';

/** Status of a single index/replica for a record deletion. */
export interface IndexDeletionStatus {
  /** Opaque index identifier (never content). */
  indexId: string;
  state: IndexDeletionState;
  /** Number of verification attempts made so far. */
  attempts: number;
  /** Epoch millis of the last state transition. */
  updatedAt: number;
}

/** Aggregate deletion status for a record, keyed by opaque record id. */
export interface RecordDeletionStatus {
  recordId: string;
  /** True only when every tracked index is verified. */
  complete: boolean;
  indexes: IndexDeletionStatus[];
}

/**
 * Authorization check for deletion verification. Only callers holding the
 * deletion-verification capability may read or mutate deletion status.
 */
export interface DeletionVerificationAuth {
  /** Capability token proving the caller may verify deletions. */
  canVerifyDeletions: boolean;
}

export class DeletionVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeletionVerificationError';
  }
}

function assertAuthorized(auth: DeletionVerificationAuth | undefined): void {
  if (!auth || auth.canVerifyDeletions !== true) {
    throw new DeletionVerificationError('Not authorized to verify search-index deletions');
  }
}

/**
 * Tracks per-index deletion completion for records, keyed by opaque record id.
 * Verification is idempotent: re-verifying a completed index is a no-op, and
 * retries only re-check indexes that are not yet verified.
 */
export class DeletionVerificationTracker {
  private readonly records = new Map<string, Map<string, IndexDeletionStatus>>();

  /** Register the set of indexes that must confirm deletion for a record. */
  register(recordId: string, indexIds: string[], now: number = Date.now()): void {
    if (!recordId) throw new DeletionVerificationError('recordId is required');
    const existing = this.records.get(recordId) ?? new Map<string, IndexDeletionStatus>();
    for (const indexId of indexIds) {
      if (!indexId) continue;
      if (!existing.has(indexId)) {
        existing.set(indexId, { indexId, state: 'pending', attempts: 0, updatedAt: now });
      }
    }
    this.records.set(recordId, existing);
  }

  /**
   * Verify deletion for a record across all registered indexes. `probe` returns
   * true when the index no longer returns the content. Already-verified indexes
   * are skipped (safe retries). Returns the aggregate status.
   */
  async verify(
    auth: DeletionVerificationAuth | undefined,
    recordId: string,
    probe: (indexId: string) => Promise<boolean> | boolean,
    now: number = Date.now(),
  ): Promise<RecordDeletionStatus> {
    assertAuthorized(auth);
    const indexes = this.records.get(recordId);
    if (!indexes) {
      throw new DeletionVerificationError('Unknown recordId');
    }
    for (const status of indexes.values()) {
      if (status.state === 'verified') continue;
      status.attempts += 1;
      let ok = false;
      try {
        ok = await probe(status.indexId);
      } catch {
        ok = false;
      }
      status.state = ok ? 'verified' : 'failed';
      status.updatedAt = now;
    }
    return this.status(auth, recordId);
  }

  /** Read aggregate status without mutating state. */
  status(auth: DeletionVerificationAuth | undefined, recordId: string): RecordDeletionStatus {
    assertAuthorized(auth);
    const indexes = this.records.get(recordId);
    if (!indexes) {
      throw new DeletionVerificationError('Unknown recordId');
    }
    const list = Array.from(indexes.values()).map((s) => ({ ...s }));
    return {
      recordId,
      complete: list.length > 0 && list.every((s) => s.state === 'verified'),
      indexes: list,
    };
  }

  /**
   * Bounded verification command: returns a content-free summary for a record.
   * Never prints deleted content — only opaque ids, states, and counts.
   */
  summarize(auth: DeletionVerificationAuth | undefined, recordId: string): string {
    const status = this.status(auth, recordId);
    const verified = status.indexes.filter((s) => s.state === 'verified').length;
    const failed = status.indexes.filter((s) => s.state === 'failed').length;
    const pending = status.indexes.filter((s) => s.state === 'pending').length;
    return [
      `record=${status.recordId}`,
      `complete=${status.complete}`,
      `verified=${verified}`,
      `failed=${failed}`,
      `pending=${pending}`,
    ].join(' ');
  }
}
