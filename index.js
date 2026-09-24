/**
 * Host half of dsh-session-billing (zero npm dependencies; the only import
 * is this package's own `models.config.js` data module).
 *
 * Pricing data (rates, model matching rules, LocalizedText notes, holiday
 * calendar) lives in `./models.config.js` — new models and price changes are
 * made there, not here.
 *
 * Registers one session-projection unit, `sessionCost`, that folds durable
 * provider-reported usage (`assistant/message` / `assistant/attempt`) into
 * per-(turn, model, time-tier) token buckets and prices them against a static
 * pay-as-you-go table (DeepSeek + Xiaomi MiMo). The wire view exposes the session
 * total (per model) plus one cost per durable turn; the Client half renders the
 * already-computed cost reached through `useProjection('sessionCost')` — as the
 * composer-dock pill and as a per-turn decoration beside the chat's own
 * "本轮用量" pill.
 *
 * Billing semantics (four disjoint usage buckets from `TokenUsage`):
 *   - cacheReadTokens     -> "cache hit" rate      (输入/缓存命中)
 *   - uncachedInputTokens -> "cache miss" rate     (输入/缓存未命中)
 *   - cacheWriteTokens    -> "cache write" rate    (缓存写入)
 *   - outputTokens        -> "output" rate         (输出)
 *
 * Rate policy per family (so each provider's published table is honoured):
 *   - DeepSeek publishes no separate cache-write price: its "cache miss" rate
 *     already covers a token written to cache, so cacheWrite is billed at the
 *     MISS rate and uncachedInput also at the MISS rate.
 *   - MiMo publishes "缓存写入：限时免费" (cache write free for now), so
 *     cacheWrite is billed at rate 0 and only uncachedInput carries the miss rate.
 *
 * Peak/idle (DeepSeek 峰谷 / 夜间优惠) — evaluated as IMPLEMENTABLE:
 *   - Every usage sample rides an event carrying `time` (Unix epoch ms).
 *   - Beijing time is fixed UTC+8 with no DST, so the wall-clock window is exact.
 *   - Peak = Beijing Mon-Fri 09:00-12:00 and 14:00-18:00, EXCLUDING Chinese
 *     statutory holidays; everything else (nights, weekends, holidays) is the
 *     idle tier at half price. The idle tier IS the "night / off-peak discount".
 *   - The ONE non-derivable input is the statutory-holiday calendar (announced
 *     yearly). It is a `config.holidays` list of "YYYY-MM-DD" dates that count as
 *     idle. With it empty a holiday weekday is billed at the (higher) peak rate,
 *     i.e. a conservative over-estimate — never an undercharge.
 *
 * Timestamp used for tiering is the assistant settlement time (`event.time`);
 * a request straddling a window boundary within its wall-clock duration can be
 * attributed to the neighbouring tier, a negligible effect against 3-4h windows.
 */

// ---------------------------------------------------------------------------- Config

/**
 * Rate table, model matching rules, LocalizedText notes, and the holiday
 * calendar all live in the package's `models.config.js` data module (relative
 * import only — this half stays free of npm dependencies).
 */
import { HOLIDAYS, matchModel } from './models.config.js';

/** Normalise the row's raw `config` with defaults (no schema dependency). */
function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const extra = Array.isArray(c.holidays)
    ? c.holidays.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];
  const currency = typeof c.currency === 'string' && c.currency ? c.currency : 'CNY';
  return { currency, holidays: [...HOLIDAYS, ...extra] };
}

// ------------------------------------------------------------------ Beijing peak/idle

const BEIJING_OFFSET_MS = 8 * 3600000; // UTC+8, no DST.

/**
 * Classify one usage sample into DeepSeek's peak or idle pricing tier.
 * @param timeMs - Unix epoch milliseconds of the assistant settlement.
 * @param holidays - Set of "YYYY-MM-DD" Beijing dates treated as idle.
 * @returns 'peak' during Beijing Mon-Fri 09:00-12:00 / 14:00-18:00 excluding holidays, else 'idle'.
 */
function beijingPeakTier(timeMs, holidays) {
  const s = new Date((Number(timeMs) || 0) + BEIJING_OFFSET_MS);
  const day = s.getUTCDay(); // 0=Sun .. 6=Sat in Beijing wall time
  const hour = s.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  const y = s.getUTCFullYear();
  const mo = String(s.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(s.getUTCDate()).padStart(2, '0');
  const dateStr = `${y}-${mo}-${dd}`;
  const inWindow = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  const peak = weekday && inWindow && !holidays.has(dateStr);
  return peak ? 'peak' : 'idle';
}

// ------------------------------------------------------------------------------ fold

const zeroBuckets = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** Coerce one optional provider counter to a non-negative integer count. */
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/** Project one raw usage sample into the four disjoint token buckets. */
function bucketsFrom(usage) {
  return {
    uncachedInputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
  };
}

function bucketsEqual(a, b) {
  return a.uncachedInputTokens === b.uncachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens;
}

/** Last `usage` chunk of an embedded compact stream, or undefined. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const rec = stream[i];
    const chunk = rec && (rec.chunk ?? rec);
    if (chunk && chunk.type === 'usage' && chunk.usage) return chunk.usage;
  }
  return undefined;
}

/** The usage one durable Assistant settlement reports, mirroring token-meter's `usageOf`. */
function usageOf(event) {
  const d = event.data;
  if (event.type === 'assistant/message' && d.usage !== undefined) return d.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  return lastStreamUsage(d.stream);
}

// One bucket per (turn, route, tier): the session total is the sum over all turns,
// so a single map serves both the session dialog and the per-turn cost decoration.
// `turn` is the durable Agent turn number; `''` marks a sample with no turn number
// (counted in the session total only).
const bucketKey = (turn, provider, model, tier) => `${turn}\u0000${provider}\u0000${model}\u0000${tier}`;

// The projection registry only ever calls `schema.parse(value)` (verified against
// dsh-session-projection), so these are dependency-free validators rather than a
// schema library. `parseState` also guards a corrupted persisted checkpoint.
function parseState(v) {
  if (v && typeof v === 'object' && v.buckets && typeof v.buckets === 'object') {
    return { route: v.route ?? null, last: v.last ?? null, buckets: v.buckets };
  }
  return { route: null, last: null, buckets: {} };
}
const stateSchema = { parse: parseState };
const viewSchema = { parse: (v) => v };

/**
 * Cost of one bucket at its tier's rates (per 1M tokens).
 * @param cell - one (route, tier) token bucket.
 * @param entry - the matched price entry.
 * @returns cost in the entry's currency.
 */
function bucketCost(cell, entry) {
  const r = cell.tier === 'peak' ? entry.peak : entry.idle;
  return (
    cell.cacheReadTokens * r.hit
    + cell.uncachedInputTokens * r.miss
    + cell.cacheWriteTokens * r.write
    + cell.outputTokens * r.out
  ) / 1e6;
}

/** Build the `sessionCost` projection definition for one resolved plugin config. */
function makeProjection(config) {
  const holidays = new Set(config.holidays ?? []);
  let cachedKey;
  let cachedView;

  /** Aggregate per-(turn,route,tier) buckets into per-model and per-turn priced rows. */
  function computeView(state) {
    // matchModel is a pure string match; memoise it per route while folding cells.
    const priceCache = new Map();
    const entryFor = (provider, model) => {
      const id = `${provider}\u0000${model}`;
      let entry = priceCache.get(id);
      if (entry === undefined) {
        entry = matchModel(provider, model);
        priceCache.set(id, entry);
      }
      return entry;
    };

    /** Accumulate one cell into the `provider\0model` row of the given map. */
    const addCell = (rows, cell, entry, cost) => {
      const id = `${cell.provider}\u0000${cell.model}`;
      let row = rows.get(id);
      if (!row) {
        row = {
          provider: cell.provider,
          model: cell.model,
          calls: 0,
          uncachedInputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          cost: 0,
          entry,
        };
        rows.set(id, row);
      }
      row.calls += cell.calls;
      row.uncachedInputTokens += cell.uncachedInputTokens;
      row.cacheReadTokens += cell.cacheReadTokens;
      row.cacheWriteTokens += cell.cacheWriteTokens;
      row.outputTokens += cell.outputTokens;
      row.cost += cost;
    };

    /** Project one accumulated row into the wire shape (an unpriced row carries no money). */
    const publicRow = (row) => {
      const entry = row.entry;
      const priced = entry !== null;
      return {
        provider: row.provider,
        model: row.model,
        label: entry ? entry.label : (row.model || row.provider || 'unknown'),
        tiered: entry ? entry.tiered : false,
        // LocalizedText ({en, zh} or plain string) resolved to the UI language
        // by the Client; null when the route is unpriced (no note to show).
        note: entry ? entry.note ?? null : null,
        priced,
        calls: row.calls,
        uncachedInputTokens: row.uncachedInputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        outputTokens: row.outputTokens,
        cost: priced ? row.cost : 0,
      };
    };

    const byModel = new Map();
    const byTurn = new Map();
    for (const cell of Object.values(state.buckets)) {
      const entry = entryFor(cell.provider, cell.model);
      // Unpriced routes contribute tokens but never money (surfaced as unpriced).
      const cost = entry ? bucketCost(cell, entry) : 0;
      addCell(byModel, cell, entry, cost);

      if (typeof cell.turn === 'number' && Number.isFinite(cell.turn)) {
        let turn = byTurn.get(cell.turn);
        if (turn === undefined) {
          turn = { cost: 0, priced: true, rows: new Map() };
          byTurn.set(cell.turn, turn);
        }
        turn.cost += cost;
        if (entry === null) turn.priced = false;
        addCell(turn.rows, cell, entry, cost);
      }
    }

    let totalCost = 0;
    let anyUnpriced = false;
    const models = [...byModel.values()]
      .sort((a, b) => b.cost - a.cost)
      .map((row) => {
        const out = publicRow(row);
        if (out.priced) totalCost += out.cost;
        else anyUnpriced = true;
        return out;
      });

    // Per-turn rows, keyed by the durable turn number the chat decorates against:
    // each carries its own per-model breakdown for the turn's detail dialog.
    const turns = {};
    for (const [turn, agg] of byTurn) {
      turns[String(turn)] = {
        cost: agg.cost,
        priced: agg.priced,
        models: [...agg.rows.values()].sort((a, b) => b.cost - a.cost).map(publicRow),
      };
    }

    return { currency: config.currency, totalCost, priced: !anyUnpriced, models, turns };
  }

  return {
    key: 'sessionCost',
    stateVersion: 3,
    stateSchema,
    init: () => ({ route: null, last: null, buckets: {} }),

    apply: (state, event) => {
      // Track the route each request is dispatched on (logged before every call),
      // used only to attribute a route-less `assistant/attempt` sample.
      if (event.type === 'request/header' || event.type === 'request/context') {
        const cfg = event.type === 'request/header' ? event.data?.header?.config : event.data;
        const provider = cfg?.provider;
        const model = cfg?.model;
        if (typeof provider === 'string' && typeof model === 'string') {
          if (state.route?.provider !== provider || state.route?.model !== model) {
            return { ...state, route: { provider, model } };
          }
        }
        return state;
      }

      // A retry closes the replacement slot so the retried attempt adds to totals.
      if (event.type === 'llm/retry-started') {
        const d = event.data;
        if (state.last && state.last.turn === d.turn && state.last.step === d.step) {
          return { ...state, last: null };
        }
        return state;
      }

      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state;
      const usage = usageOf(event);
      if (usage === undefined) return state;

      let provider;
      let model;
      if (event.type === 'assistant/message') {
        const src = event.data?.message?.source;
        if (src && typeof src.provider === 'string' && typeof src.model === 'string'
          && src.provider.length > 0 && src.model.length > 0) {
          provider = src.provider;
          model = src.model;
        }
      }
      if (!provider || !model) {
        if (state.route) { provider = state.route.provider; model = state.route.model; }
        else { provider = ''; model = ''; }
      }

      const next = bucketsFrom(usage);
      const { turn, step } = event.data;
      const turnId = typeof turn === 'number' && Number.isFinite(turn) ? turn : '';
      const prev = state.last && state.last.turn === turn && state.last.step === step ? state.last : undefined;
      if (prev && bucketsEqual(prev.buckets, next)) return state;

      const tier = beijingPeakTier(event.time, holidays);
      const key = bucketKey(turnId, provider, model, tier);
      const buckets = { ...state.buckets };

      // Remove a superseded sample from the bucket it landed in.
      if (prev) {
        const p = buckets[prev.key];
        if (p) {
          buckets[prev.key] = {
            ...p,
            uncachedInputTokens: p.uncachedInputTokens - prev.buckets.uncachedInputTokens,
            outputTokens: p.outputTokens - prev.buckets.outputTokens,
            cacheReadTokens: p.cacheReadTokens - prev.buckets.cacheReadTokens,
            cacheWriteTokens: p.cacheWriteTokens - prev.buckets.cacheWriteTokens,
          };
        }
      }

      const target = buckets[key] ?? { turn: turnId, provider, model, tier, calls: 0, ...zeroBuckets() };
      buckets[key] = {
        ...target,
        uncachedInputTokens: target.uncachedInputTokens + next.uncachedInputTokens,
        outputTokens: target.outputTokens + next.outputTokens,
        cacheReadTokens: target.cacheReadTokens + next.cacheReadTokens,
        cacheWriteTokens: target.cacheWriteTokens + next.cacheWriteTokens,
        calls: target.calls + (prev ? 0 : 1),
      };

      return { ...state, buckets, last: { turn, step, key, buckets: next } };
    },

    wire: {
      viewSchema,
      view: (state) => {
        // Reuse the reference while the priced content is unchanged so route-only
        // and dedup state moves do not publish a redundant client update.
        const key = JSON.stringify(state.buckets);
        if (key === cachedKey) return cachedView;
        cachedKey = key;
        cachedView = computeView(state);
        return cachedView;
      },
    },
  };
}

// ------------------------------------------------------------------------------ apply

export const inject = ['sessionProjections'];

export function apply(ctx, config) {
  ctx.sessionProjections.register(makeProjection(resolveConfig(config)));
}
