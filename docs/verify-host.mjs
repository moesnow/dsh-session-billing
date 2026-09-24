/**
 * 本地校验脚本（不进包）：合成事件跑 Host 折叠 + 计价断言。
 * 用法：node docs/verify-host.mjs   （退出码非 0 = 有断言失败）
 * 也顺带验证 index.js 对 models.config.js 的相对 import 能解析。
 */
import assert from 'node:assert/strict';
import { apply } from '../index.js';
import { matchModel, MODELS, HOLIDAYS } from '../models.config.js';

/** 用全新的投影实例跑一个场景（wire.view 的 memo 每实例只有一个槽，别共用）。 */
function fresh() {
  let def = null;
  apply({ sessionProjections: { register: (d) => { def = d; } } }, {});
  assert.ok(def, 'projection registered');
  const events = [];
  return {
    def,
    push(...evs) { events.push(...evs); },
    view() {
      let state = def.init();
      for (const e of events) state = def.apply(state, e);
      return def.wire.view(state);
    },
  };
}

// 北京时间（UTC+8）→ epoch ms
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
const msg = ({ time, turn, step, provider, model, usage }) => ({
  type: 'assistant/message',
  time,
  data: { turn, step, usage, message: { source: { provider, model } } },
});

// ---------------------------------------------------------------- matchModel
assert.equal(matchModel('xiaomi', 'mimo-v2.6-pro-ultraspeed').id, 'mimo-v2.6-pro-ultraspeed');
assert.equal(matchModel('xiaomi', 'mimo-v2.5-pro').id, 'mimo-v2.6-pro');
assert.equal(matchModel('xiaomi', 'mimo-v2.5').id, 'mimo-v2.6-flash');
assert.equal(matchModel('deepseek', 'deepseek-v4-pro').id, 'deepseek-v4-pro');
assert.equal(matchModel('deepseek', 'v4-flash-250115').id, 'deepseek-flash');
assert.equal(matchModel('some-route', 'v4-flash').id, 'deepseek-flash');   // 遗留别名不带 deepseek 前缀
assert.equal(matchModel('deepseek', 'deepseek-v4-flash').id, 'deepseek-flash');
assert.equal(matchModel('deepseek', 'deepseek-reasoner'), null);          // 未知名不猜价
assert.equal(matchModel('acme', 'widget-flash'), null);                   // 别家 flash 不套 DeepSeek 价
for (const e of MODELS) assert.ok(e.note && e.note.en, `${e.id} 需要带 en 的说明`);
assert.ok(HOLIDAYS.includes('2026-02-17'));

// ------------------------------------------------- 峰谷两档 + 写入口径差异
{
  const s = fresh();
  s.push(msg({ time: bj(2026, 3, 2, 10), turn: 1, step: 0, provider: 'deepseek', model: 'deepseek-v4-flash',
    usage: { inputTokens: 1e6, cacheReadTokens: 2e6, cacheWriteTokens: 5e5, outputTokens: 1e5 } }));
  // 13:00（12-14 休窗）→ 空闲档
  s.push(msg({ time: bj(2026, 3, 2, 13), turn: 2, step: 0, provider: 'deepseek', model: 'deepseek-v4-flash',
    usage: { inputTokens: 1e6, outputTokens: 0 } }));
  const v = s.view();
  // 峰：2e6*0.04 + 1e6*2 + 5e5*2(写入=未命中价) + 1e5*8 = 3.88；谷：1e6*1 = 1.0
  assert.ok(Math.abs(v.turns['1'].cost - 3.88) < 1e-9, `turn1 峰价 = ${v.turns['1'].cost}`);
  assert.ok(Math.abs(v.turns['2'].cost - 1.0) < 1e-9, `turn2 谷价 = ${v.turns['2'].cost}`);
  assert.ok(Math.abs(v.totalCost - 4.88) < 1e-9, `合计 = ${v.totalCost}`);
  assert.equal(v.models.length, 1);
  assert.equal(v.models[0].tiered, true);
  assert.deepEqual(Object.keys(v.models[0].note).sort(), ['en', 'zh']);
  // memo：重复 view 返回同一引用
  assert.equal(s.view(), v);
}
{
  // MiMo：缓存写入 0 元；全天一口价（深夜也是这个价）
  const s = fresh();
  s.push(msg({ time: bj(2026, 3, 2, 3), turn: 1, step: 0, provider: 'xiaomi', model: 'mimo-v2.6-pro',
    usage: { inputTokens: 1e6, cacheWriteTokens: 1e6, outputTokens: 1e6 } }));
  const v = s.view();
  assert.ok(Math.abs(v.totalCost - 9.0) < 1e-9, `MiMo 写入 0 = ${v.totalCost}`);
  assert.equal(v.models[0].tiered, false);
}
{
  // 工作日法定节假日（2026-02-17）按空闲半价
  const s = fresh();
  s.push(msg({ time: bj(2026, 2, 17, 10), turn: 1, step: 0, provider: 'deepseek', model: 'deepseek-v4-flash',
    usage: { inputTokens: 1e6 } }));
  assert.ok(Math.abs(s.view().totalCost - 1.0) < 1e-9, '节假日工作日 = 空闲价');
}

// ------------------------------------------------------- 未标价不猜价
{
  const s = fresh();
  s.push(msg({ time: bj(2026, 3, 2, 10), turn: 1, step: 0, provider: 'acme', model: 'widget-9000',
    usage: { inputTokens: 1e6, outputTokens: 1e6 } }));
  const v = s.view();
  assert.equal(v.totalCost, 0);
  assert.equal(v.models[0].priced, false);
  assert.equal(v.models[0].note, null);
  assert.equal(v.models[0].uncachedInputTokens, 1e6);   // token 仍保留
  assert.equal(v.turns['1'].priced, false);
  assert.equal(v.turns['1'].cost, 0);
}

// ------------------------------------- 每轮：去重替换 / retry 另计 / 合计=各轮之和
{
  const s = fresh();
  const flash = { provider: 'xiaomi', model: 'mimo-v2.6-flash' }; // out 2.0 元/M
  // turn 3 step 0 先来一版、再被同 (turn,step) 的新样本替换 → 只算后者
  s.push(msg({ time: bj(2026, 3, 2, 10), turn: 3, step: 0, ...flash, usage: { outputTokens: 1e6 } }));
  s.push(msg({ time: bj(2026, 3, 2, 10), turn: 3, step: 0, ...flash, usage: { outputTokens: 2e6 } }));
  // turn 3 step 1：调用一次，retry 后再来一次 → 两次都计
  s.push(msg({ time: bj(2026, 3, 2, 10), turn: 3, step: 1, ...flash, usage: { outputTokens: 1e6 } }));
  s.push({ type: 'llm/retry-started', time: bj(2026, 3, 2, 10), data: { turn: 3, step: 1 } });
  s.push(msg({ time: bj(2026, 3, 2, 10), turn: 3, step: 1, ...flash, usage: { outputTokens: 1e6 } }));
  // turn 4：未标价路由
  s.push(msg({ time: bj(2026, 3, 2, 10), turn: 4, step: 0, provider: 'acme', model: 'widget-9000', usage: { inputTokens: 5e5 } }));
  const v = s.view();
  assert.ok(Math.abs(v.turns['3'].cost - 8.0) < 1e-9, `turn3 = ${v.turns['3'].cost}（替换 + retry 另计）`);
  assert.equal(v.turns['3'].priced, true);
  assert.equal(v.turns['4'].priced, false);
  assert.equal(v.turns['4'].models[0].uncachedInputTokens, 5e5);
  assert.equal(Object.keys(v.turns['3'].models).length, 1);         // 只含该轮的路由
  const sum = Object.values(v.turns).reduce((a, t2) => a + t2.cost, 0);
  assert.ok(Math.abs(sum - v.totalCost) < 1e-9, '会话合计 = 各轮之和');
  // 按 cost 降序
  const costs = v.models.map((m) => m.cost);
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a));
}

console.log('verify-host: all assertions passed');
