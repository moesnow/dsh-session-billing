/**
 * dsh-session-billing 的模型配置文件（价目表 + 匹配规则 + 说明文案 + 节假日）。
 *
 * 新增 / 调价 / 改说明 = 只改这一个文件，然后重启 Harness（Host 半侧不热更）。
 * 价格单位：元 / 百万 tokens。来源（截至抓取时）：
 *   GLM       https://docs.bigmodel.cn/cn/guide/start/pricing
 *   DeepSeek  https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *   MiMo      https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go
 *
 * 计费口径（四桶互斥，见 AGENTS §4，别改错）：
 *   hit   = 输入(缓存命中)   -> cacheReadTokens
 *   miss  = 输入(未命中缓存) -> uncachedInputTokens
 *   write = 缓存写入         -> cacheWriteTokens
 *   out   = 输出             -> outputTokens
 *   - DeepSeek 无单列写入价：write = miss 价（写入即按未命中计）。
 *   - MiMo 「缓存写入限时免费」：write = 0。务必保持两家的 write 差异。
 *   - GLM 同样无单列写入价，且缓存存储限时免费：write = 0（与 MiMo 同口径）。
 *
 * 说明文案用 DSH 的 LocalizedText 形状：{ en: '...', zh: '...' }（en 必填，
 * 语言 id 小写）。Host 原样下发，Client 按界面当前语言解析并跟随应用语言切换。
 * 同族模型共用一份文案常量即可，个别模型想单独说明就内联自己的 { en, zh }。
 */

// ------------------------------------------------------------------ 说明文案

/** DeepSeek 峰谷计价说明（tiered 条目共用）。 */
const NOTE_DEEPSEEK_TIERED = {
  en: 'Priced by Beijing peak/idle: peak is weekdays 09:00-12:00 & 14:00-18:00; nights, weekends and statutory holidays are idle at half price (holiday calendar from holiday-cn).',
  zh: '按北京时间峰谷计价：工作日 9:00-12:00、14:00-18:00 为高峰价，其余时段（夜间、周末及法定节假日）为空闲半价。节假日依据 holiday-cn 日历。',
};

/** MiMo 一口价说明（无峰谷 + 缓存写入免费，共用）。 */
const NOTE_MIMO_FLAT = {
  en: 'Flat price all day (no peak/idle); cache write is free for now, billed at 0.',
  zh: '全天一口价（无峰谷）；缓存写入限时免费，按 0 计。',
};

/**
 * GLM 一口价说明（无峰谷 + 缓存写入/存储当前免费，共用）。
 * 智谱价目表只列「输入 / 输出 / 缓存命中 / 缓存存储」四项，没有单列缓存写入价，
 * 而缓存存储按「元/百万 Tokens/小时」计时长计费，当前限时免费——插件的四桶模型
 * 是按 token 一次性计价，无法表达时长，故缓存存储暂不计入。
 */
const NOTE_GLM_FLAT = {
  en: 'Flat price all day (no peak/idle); cache write is billed at 0 (Zhipu publishes no separate cache-write price), and cache storage is free for now so it is not included.',
  zh: '全天一口价（无峰谷）；智谱未单列缓存写入价，按 0 计；缓存存储限时免费，暂不计入。',
};

// -------------------------------------------------------------------- 价目表

/**
 * 模型条目（按序匹配，第一条命中即用；认不出的模型返回 null，UI 标
 * 「未配置价格」，不猜价）。
 *
 * 字段：
 *   id     - 稳定标识，仅用于维护辨认。
 *   label  - 显示名（语言无关）。
 *   match  - 匹配规则（都小写包含匹配，见 matchModel）：
 *              route:   provider 或 model 任一包含其一即算命中（可选）。
 *              model:   model 必须包含列出的每一项（可选）。
 *              exclude: model 不得包含任何一项（可选）。
 *   tiered - 是否峰谷计价（true 时 Client 显示「峰谷」徽标与 DeepSeek 说明）。
 *   peak / idle - 两档单价 { hit, miss, write, out }；无峰谷的模型两档写一样。
 *   note   - LocalizedText 说明文案。
 */
export const MODELS = [
  // ------------------------------------------------------------------ GLM
  // 智谱（BigModel）新一代旗舰：1M 上下文、均不分输入长度段、不按时段计价。
  // 只收这一代是刻意的：GLM-5.1 / 5-Turbo / 5 / 4.5-Air / 4.7 / 4.6V / 4.5V 等
  // 按输入长度分段计价（<32K 与 >=32K 两档），而匹配只认 provider+model、拿不到
  // 输入长度，无法判档，收进来必然系统性误报（取低档则低估长上下文会话）。
  // 分段模型留白 = UI 标「未配置价格」，不猜价。
  //
  // 注意 route 限定：智谱生态的模型名有 Air / AirX / Flash / FlashX / Long /
  // Plus 等大量同族后缀，且别家也有 "flash"，所以每条都用 model+route 双限定，
  // 避免把 GLM-5.3-Flash 误套成 GLM-5.3 的价。
  {
    // 旗舰：输入 8 / 输出 28 / 缓存命中 2（元每百万 tokens）。
    id: 'glm-5.3',
    label: 'GLM-5.3',
    match: { route: ['glm', 'zhipu'], model: ['glm', '5.3'], exclude: ['flash', 'flashx', 'air', 'airx'] },
    tiered: false,
    peak: { hit: 2.0, miss: 8.0, write: 0.0, out: 28.0 },
    idle: { hit: 2.0, miss: 8.0, write: 0.0, out: 28.0 },
    note: NOTE_GLM_FLAT,
  },
  {
    // 视觉/多模态 Flash：输入 0.8 / 输出 2.8 / 缓存命中 0.23。
    id: 'glm-5.3-flash',
    label: 'GLM-5.3 Flash',
    match: { route: ['glm', 'zhipu'], model: ['glm', '5.3', 'flash'], exclude: ['flashx'] },
    tiered: false,
    peak: { hit: 0.23, miss: 0.8, write: 0.0, out: 2.8 },
    idle: { hit: 0.23, miss: 0.8, write: 0.0, out: 2.8 },
    note: NOTE_GLM_FLAT,
  },
  {
    // Flash 高速档：输入 2 / 输出 7 / 缓存命中 0.57。
    id: 'glm-5.3-flashx',
    label: 'GLM-5.3 FlashX',
    match: { route: ['glm', 'zhipu'], model: ['glm', '5.3', 'flashx'] },
    tiered: false,
    peak: { hit: 0.57, miss: 2.0, write: 0.0, out: 7.0 },
    idle: { hit: 0.57, miss: 2.0, write: 0.0, out: 7.0 },
    note: NOTE_GLM_FLAT,
  },
  {
    // 上一代旗舰：与 GLM-5.3 同价（输入 8 / 输出 28 / 缓存命中 2）。
    // 放在 5.3 之后：5.3 各款的 exclude 已经排掉了 5.2 之外的混淆，而带 air/flash
    // 后缀的 5.2 变体不分段，但智谱未载明价目 —— 见下面 5.2 的 exclude。
    id: 'glm-5.2',
    label: 'GLM-5.2',
    match: { route: ['glm', 'zhipu'], model: ['glm', '5.2'], exclude: ['flash', 'flashx', 'air', 'airx'] },
    tiered: false,
    peak: { hit: 2.0, miss: 8.0, write: 0.0, out: 28.0 },
    idle: { hit: 2.0, miss: 8.0, write: 0.0, out: 28.0 },
    note: NOTE_GLM_FLAT,
  },
  {
    // 兜住其余已收录价目的 GLM 文本/视觉模型（GLM-4.7-FlashX、GLM-4.6V 等不便
    // 逐条穷举的）。刻意不做「glm 全兜底」：分段计价与免费模型太多，兜底会制造
    // 系统性错价，宁可落在「未配置价格」上让人看见缺口。
    id: 'glm-flashx-generic',
    label: 'GLM FlashX',
    match: { route: ['glm', 'zhipu'], model: ['flashx'] },
    tiered: false,
    peak: { hit: 0.1, miss: 0.5, write: 0.0, out: 3.0 },
    idle: { hit: 0.1, miss: 0.5, write: 0.0, out: 3.0 },
    note: NOTE_GLM_FLAT,
  },
  // ------------------------------------------------------------------ MiMo
  {
    id: 'mimo-v2.6-pro-ultraspeed',
    label: 'MiMo v2.6 Pro Ultraspeed',
    match: { model: ['ultraspeed'] },
    tiered: false,
    peak: { hit: 0.25, miss: 30.0, write: 0.0, out: 60.0 },
    idle: { hit: 0.25, miss: 30.0, write: 0.0, out: 60.0 },
    note: NOTE_MIMO_FLAT,
  },
  {
    id: 'mimo-v2.6-pro',
    label: 'MiMo v2.6 Pro',
    match: { model: ['mimo', 'pro'] },
    tiered: false,
    peak: { hit: 0.025, miss: 3.0, write: 0.0, out: 6.0 },
    idle: { hit: 0.025, miss: 3.0, write: 0.0, out: 6.0 },
    note: NOTE_MIMO_FLAT,
  },
  {
    // 兜住其余 mimo 模型（v2.6 / v2.5 等 flash 档）。
    id: 'mimo-v2.6-flash',
    label: 'MiMo v2.6 Flash',
    match: { model: ['mimo'] },
    tiered: false,
    peak: { hit: 0.02, miss: 1.0, write: 0.0, out: 2.0 },
    idle: { hit: 0.02, miss: 1.0, write: 0.0, out: 2.0 },
    note: NOTE_MIMO_FLAT,
  },
  {
    // DeepSeek 空闲价 = 高峰价的一半，两档都显式写出。
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    match: { route: ['deepseek', 'v4-pro'], model: ['pro'], exclude: ['flash'] },
    tiered: true,
    peak: { hit: 0.30, miss: 9.0, write: 9.0, out: 27.0 },
    idle: { hit: 0.15, miss: 4.5, write: 4.5, out: 13.5 },
    note: NOTE_DEEPSEEK_TIERED,
  },
  {
    // deepseek-flash 与遗留别名 deepseek-v4-flash* 都按 Flash 计价。
    // route 限定 deepseek / v4-flash：别把别家的 "xxx-flash" 误套成 DeepSeek 价。
    id: 'deepseek-flash',
    label: 'DeepSeek Flash',
    match: { route: ['deepseek', 'v4-flash'], model: ['flash'] },
    tiered: true,
    peak: { hit: 0.04, miss: 2.0, write: 2.0, out: 8.0 },
    idle: { hit: 0.02, miss: 1.0, write: 1.0, out: 4.0 },
    note: NOTE_DEEPSEEK_TIERED,
  },
];

/**
 * 把一条路由解析到价目表条目（小写包含匹配，按 MODELS 顺序首命中即返回）。
 * @param provider - provider 路由键。
 * @param model - 模型 id。
 * @returns 命中的条目，未知名返回 null（不猜价）。
 */
export function matchModel(provider, model) {
  const m = String(model ?? '').toLowerCase();
  const route = `${String(provider ?? '').toLowerCase()}\u0000${m}`;
  for (const entry of MODELS) {
    const rule = entry.match ?? {};
    if (rule.exclude && rule.exclude.some((s) => m.includes(s))) continue;
    if (rule.model && !rule.model.every((s) => m.includes(s))) continue;
    if (rule.route && !rule.route.some((s) => route.includes(s))) continue;
    return entry;
  }
  return null;
}

// ---------------------------------------------------------------- 节假日日历

/**
 * 内置中国法定节假日「放假」日期（YYYY-MM-DD），用于 DeepSeek 峰谷判档
 * （工作日节假日按空闲半价）。快照自开源数据集
 * https://github.com/NateScarlet/holiday-cn （每日抓取国务院公告、数据变更
 * 自动发版），取其 {年份}.json 的 `isOffDay: true` 条目，已含 2025+2026
 * （2027 国务院尚未公布）。年底从该库取新年份补进来即可。
 *
 * 调休补班日（isOffDay:false 的周末上班日）无需登记：DeepSeek 本就把周末
 * 算空闲，判档逻辑同样如此。留空的工作日节假日会被按高峰价高估（只会多算）。
 * plugin config 的 `holidays` 追加项与本表取并集。
 */
export const HOLIDAYS = [
  // 2025
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-04-05', '2025-04-06',
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  '2025-05-31', '2025-06-01', '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
];
