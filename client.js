window.__ModuleLoader__.load({
  id: 'dsh-session-billing',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // react-dom is optional: fall back to inline rendering if it is not in the table.
    let createPortal;
    try {
      const ReactDOM = require('react-dom');
      createPortal = ReactDOM && ReactDOM.createPortal;
    } catch (_) {
      createPortal = undefined;
    }

    // ---------------------------------------------------------------- i18n
    // 界面固定文案走 Client locale 服务：字典注册进 `sessionBilling` 命名空间，
    // `t` 在调用时读当前语言，跟随应用语言实时切换（组件重渲染 + 每轮贴片
    // re-sync）。模型说明则是「随数据走」的 LocalizedText（{en,zh} 映射，见
    // models.config.js），由 Host 随 view 下发、这里按当前语言解析。
    var NS = 'sessionBilling';
    var DICT = {
      en: {
        title: 'Session cost',
        byModel: 'By model',
        calls: '{n} calls',
        unpriced: 'no price configured',
        estimate: 'Cost is an estimate from the published price sheets.',
        turnTitle: 'Turn cost',
        turnCost: "This turn's cost (estimated from the published price sheets)",
        badgePeakIdle: 'peak/idle'
      },
      zh: {
        title: '会话费用',
        byModel: '按模型',
        calls: '{n} 次调用',
        unpriced: '未配置价格',
        estimate: '费用为按官方价目表的估算值。',
        turnTitle: '本轮费用',
        // 未标价的路由按 ¥0 显示（与会话面板、每轮面板一致）；只有模型行才标出
        // 「未配置价格」，说明这个 0 是因为价目表里没有它。
        turnCost: '本轮费用（按官方价目表估算）',
        badgePeakIdle: '峰谷'
      }
    };

    // locale 服务面，apply() 里探测；缺失时退回 navigator.language 本地查表。
    var localeFace = null;

    /** 当前语言 id（小写 BCP 47，如 zh-cn / en-us）。 */
    function activeLocaleId() {
      if (localeFace) {
        try { return String(localeFace.getLocale().active || 'en').toLowerCase(); } catch (_) {}
      }
      return String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase();
    }
    function activeLang() { return activeLocaleId().split('-')[0]; }

    function interpolate(str, params) {
      return String(str).replace(/\{(\w+)\}/g, function (all, key) {
        return params && params[key] != null ? String(params[key]) : all;
      });
    }

    /** 本地查表版翻译（locale 服务缺失时的兜底）。 */
    function localT(key, params) {
      var dict = DICT[activeLang()] || DICT.en;
      var s = dict[key];
      if (s === undefined) s = DICT.en[key];
      if (s === undefined) return key;
      return params ? interpolate(s, params) : s;
    }

    /**
     * 按当前语言解析一条 LocalizedText（{en,zh} 映射或纯字符串）：精确语言 id
     * → 主语言子标签（zh-cn 归 zh）→ en → 第一项。
     */
    function pickLocalized(text) {
      if (text == null) return null;
      if (typeof text === 'string') return text;
      var id = activeLocaleId();
      return text[id] || text[activeLang()] || text.en || text[Object.keys(text)[0]] || null;
    }

    // apply() 里优先换成 locale 服务的 bind(ns)（调用时读当前语言，引用稳定）。
    var t = localT;

    function subscribeLocale(fn) {
      return localeFace ? localeFace.subscribe(fn) : function () {};
    }
    function localeRevision() {
      return localeFace ? localeFace.getSnapshot().revision : 0;
    }
    // 语言/字典变化时的重渲染信号（usES 可用则用之，旧 React 退回订阅计数）。
    var useLocaleRevision = typeof React.useSyncExternalStore === 'function'
      ? function () { return React.useSyncExternalStore(subscribeLocale, localeRevision); }
      : function () {
          var st = React.useState(0);
          React.useEffect(function () {
            return subscribeLocale(function () { st[1](function (n) { return n + 1; }); });
          }, []);
          return st[0];
        };
    // ---------------------------------------------------------------- format
    function currencySymbol(code) {
      if (code === 'CNY') return '¥';
      if (code === 'USD') return '$';
      return code + ' ';
    }
    function fmtCost(v, sym) {
      var a = Math.abs(v);
      if (a < 0.00005) return sym + '0';
      if (a < 0.0001) return '<' + sym + '0.0001';
      if (a < 1) return sym + v.toFixed(4);
      if (a < 100) return sym + v.toFixed(2);
      return sym + v.toFixed(1);
    }
    function fmtTokens(n) {
      return Number(n || 0).toLocaleString();
    }

    // ---------------------------------------------------------------- dialog hook
    /**
     * Place one fixed panel fully inside the viewport relative to an anchor: prefer
     * just below, flip ABOVE it when there is not enough room (both the composer dock
     * and the chat's action rows sit near the bottom of the screen), clamp
     * horizontally, and keep it inside the last resort margin.
     * @param anchor - element the panel is anchored to.
     * @param panel - the measured, currently open panel element.
     * @returns fixed `{top, left}` for the panel.
     */
    function placePanel(anchor, panel) {
      var a = anchor.getBoundingClientRect();
      var pw = panel.offsetWidth;
      var ph = panel.offsetHeight;
      var vw = window.innerWidth || document.documentElement.clientWidth || 0;
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      var left = Math.max(8, Math.min(a.left, vw - pw - 8));
      var top;
      var below = a.bottom + 8;
      var above = a.top - ph - 8;
      if (below + ph <= vh - 8) top = below;
      else if (above >= 8) top = above;
      else top = Math.max(8, vh - ph - 8);
      return { top: top, left: left };
    }

    function useDialog() {
      var state = React.useState(false);
      var open = state[0];
      var setOpen = state[1];
      var posState = React.useState(null);
      var pos = posState[0];
      var setPos = posState[1];
      var rootRef = React.useRef(null);
      var panelRef = React.useRef(null);
      React.useEffect(function () {
        if (!open) return undefined;
        function onKey(e) { if (e.key === 'Escape') setOpen(false); }
        function onClick(e) {
          if (panelRef.current && panelRef.current.contains(e.target)) return;
          if (rootRef.current && rootRef.current.contains(e.target)) return;
          setOpen(false);
        }
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onClick);
        return function () {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onClick);
        };
      }, [open]);
      // Measure before paint so the hidden -> positioned swap never flashes.
      React.useLayoutEffect(function () {
        if (!open) { setPos(null); return; }
        var anchor = rootRef.current;
        var panel = panelRef.current;
        if (!anchor || !panel) return;
        setPos(placePanel(anchor, panel));
      }, [open]);
      var toggle = React.useCallback(function () {
        setPos(null);
        setOpen(function (prev) { return !prev; });
      }, []);
      return { open: open, setOpen: setOpen, toggle: toggle, rootRef: rootRef, panelRef: panelRef, pos: pos };
    }

    /**
     * One dialog opened from a per-turn chip the decorator injected into the chat
     * (that anchor is plain DOM, not a rendered element, so it is carried in state).
     * @returns the open `{turn, anchor}` (null when closed), `{top,left}` position,
     *          the toggling `open(turn, anchor)` and `close()` actions, and the panel ref.
     */
    function useTurnDialog() {
      var state = React.useState(null);
      var current = state[0];
      var setCurrent = state[1];
      var posState = React.useState(null);
      var pos = posState[0];
      var setPos = posState[1];
      var panelRef = React.useRef(null);
      React.useEffect(function () {
        if (!current) return undefined;
        function onKey(e) { if (e.key === 'Escape') setCurrent(null); }
        function onClick(e) {
          if (panelRef.current && panelRef.current.contains(e.target)) return;
          if (current.anchor && current.anchor.contains(e.target)) return;
          setCurrent(null);
        }
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onClick);
        return function () {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onClick);
        };
      }, [current]);
      React.useLayoutEffect(function () {
        if (!current) { setPos(null); return; }
        var anchor = current.anchor;
        var panel = panelRef.current;
        if (!anchor || !panel) return;
        // The row can scroll out of the virtualized chat while its dialog is open.
        if (anchor.isConnected === false) { setCurrent(null); return; }
        setPos(placePanel(anchor, panel));
      }, [current]);
      var open = React.useCallback(function (turn, anchor) {
        setPos(null);
        setCurrent(function (prev) {
          return prev && prev.turn === turn ? null : { turn: turn, anchor: anchor };
        });
      }, []);
      var close = React.useCallback(function () { setCurrent(null); }, []);
      return { current: current, pos: pos, open: open, close: close, panelRef: panelRef };
    }

    // ---------------------------------------------------------------- styles
    var CSS = ''
      + '.sessionBilling_root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;display:flex}'
      + '.sessionBilling_anchor{min-width:0;display:inline-flex}'
      + '.sessionBilling_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-secondary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}'
      + '.sessionBilling_pill svg{flex:none;width:14px;height:14px}'
      + 'button.sessionBilling_pill{cursor:pointer}'
      + 'button.sessionBilling_pill:hover,button.sessionBilling_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}'
      + '.sessionBilling_panel{position:fixed;z-index:1100;box-sizing:border-box;width:300px;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);max-height:calc(100vh - 24px);overflow-y:auto;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-secondary);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;cursor:default}'
      + '.sessionBilling_title{display:flex;align-items:center;gap:8px;font-weight:500;color:var(--dsw-alias-label-primary);margin-bottom:8px}'
      + '.sessionBilling_title svg{width:16px;height:16px;flex:none}'
      + '.sessionBilling_titleSpacer{flex:1}'
      + '.sessionBilling_titleValue{font-variant-numeric:tabular-nums}'
      + '.sessionBilling_rule{height:0;border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}'
      + '.sessionBilling_model{margin:10px 0 0}'
      + '.sessionBilling_modelHead{display:flex;align-items:baseline;gap:8px}'
      + '.sessionBilling_modelName{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}'
      + '.sessionBilling_badge{font-size:11px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 5px;white-space:nowrap}'
      + '.sessionBilling_modelSpacer{flex:1}'
      + '.sessionBilling_modelCost{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}'
      + '.sessionBilling_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:3px}'
      + '.sessionBilling_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:2px}'
      + '.sessionBilling_notes{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:12px;display:flex;flex-direction:column;gap:4px}'
      // Per-turn chip decorated into the chat action row, next to the official
      // 「本轮用量」 pill: same metrics as the official trigger it follows, and a
      // button so clicking it opens the turn's detail dialog.
      + '.sessionBilling_turnChip{box-sizing:border-box;height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;border-radius:28px;align-items:center;gap:4px;padding:6px 8px;display:inline-flex}'
      + '.sessionBilling_turnChip:hover,.sessionBilling_turnChip[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}'
      + '.sessionBilling_turnChip svg{flex:none;width:14px;height:14px}';

    // Price-tag icon (monochrome line style): 价签.
    var ICON_PATHS = ''
      + '<path d="M11 3.5H20v9l-8.5 8.5a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8z"/>'
      + '<circle cx="16.5" cy="7.5" r="1.3"/>';
    var ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
      + ' width="14" height="14" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true" focusable="false">' + ICON_PATHS + '</svg>';

    function Icon() {
      return h('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': true, focusable: 'false',
        dangerouslySetInnerHTML: { __html: ICON_PATHS }
      });
    }

    // ------------------------------------------------- chat per-turn decoration
    // The chat's per-turn usage pill (panel title「本轮用量」) is shipped by the
    // official chat plugin with no slot after it, so the cost of that turn is
    // decorated into the same action row. One document-level observer re-attaches
    // the chip whenever React re-renders that row (new turn, hover reveal,
    // virtualized remount), and it disappears with the row it belongs to. The chip
    // is a button whose click is bridged to the owning React component's dialog.
    var CHIP_ATTR = 'data-session-billing-turn';
    var CHIP_SELECTOR = '[' + CHIP_ATTR + ']';
    // Our own chip is also a `aria-haspopup="dialog"` button, so it must never be
    // mistaken for the official usage pill it is anchored to.
    var PILL_SELECTOR = 'button[aria-haspopup="dialog"]:not(' + CHIP_SELECTOR + ')';

    function createTurnCostChips() {
      var data = null;
      var holders = 0;
      var observer = null;
      var handlers = null;
      var activeTurn = null;

      /** The official per-turn usage trigger inside one turn-tail node. */
      function usagePill(root) {
        return root.querySelector(PILL_SELECTOR);
      }

      /** Insert after the pill's own wrapper so the row's flex gap spaces the chip. */
      function boxOf(pill) {
        var parent = pill.parentElement;
        return parent && parent !== pill && parent.childElementCount === 1 ? parent : pill;
      }

      function makeChip(turn) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.setAttribute(CHIP_ATTR, turn);
        chip.setAttribute('aria-haspopup', 'dialog');
        chip.setAttribute('aria-expanded', 'false');
        chip.className = 'sessionBilling_turnChip';
        chip.innerHTML = ICON_SVG + '<span class="sessionBilling_turnChipValue"></span>';
        // The React owner opens the detail dialog; without one the chip is inert.
        chip.addEventListener('click', function () {
          if (handlers && handlers.open) handlers.open(chip.getAttribute(CHIP_ATTR), chip);
        });
        return chip;
      }

      /** Drop one chip, telling the owner when it was the one being shown. */
      function dropChip(chip) {
        if (!chip || !chip.parentNode) return;
        var turn = chip.getAttribute(CHIP_ATTR);
        chip.parentNode.removeChild(chip);
        if (turn !== null && turn === activeTurn && handlers && handlers.close) handlers.close();
      }

      /**
       * Reconcile every completed turn's chip with the current projection value.
       * Only touches the DOM when something actually differs, so the observer it
       * runs under cannot feed itself.
       */
      function sync() {
        var sym = currencySymbol((data && data.currency) || 'CNY');
        var roots = document.querySelectorAll('[data-turn-tail]');
        for (var i = 0; i < roots.length; i += 1) {
          var root = roots[i];
          var turn = root.getAttribute('data-turn-tail');
          var entry = data && data.turns ? data.turns[turn] : undefined;
          var pill = entry ? usagePill(root) : null;
          var chip = root.querySelector(CHIP_SELECTOR);
          if (!entry || !pill) {
            dropChip(chip);
            continue;
          }
          if (!chip) chip = makeChip(turn);
          var box = boxOf(pill);
          if (box.nextElementSibling !== chip) box.insertAdjacentElement('afterend', chip);
          if (chip.getAttribute(CHIP_ATTR) !== turn) chip.setAttribute(CHIP_ATTR, turn);
          // Unpriced turns are worth ¥0 here, exactly like the session total; the
          // per-model rows are what call out "no price configured".
          var label = fmtCost(entry.cost, sym);
          var value = chip.lastElementChild;
          if (value && value.textContent !== label) value.textContent = label;
          var aria = t('turnTitle') + ': ' + label;
          if (chip.getAttribute('aria-label') !== aria) chip.setAttribute('aria-label', aria);
          var tip = t('turnCost');
          if (chip.title !== tip) chip.title = tip;
        }
      }

      /**
       * Whether one mutation can change what a turn tail needs: the tail itself,
       * one of our chips, or the official usage pill appearing/disappearing inside
       * an existing row (detailed <-> compact switch).
       */
      function affected(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.hasAttribute('data-turn-tail') || node.hasAttribute(CHIP_ATTR)) return true;
        if (typeof node.matches === 'function' && node.matches(PILL_SELECTOR)) return true;
        return typeof node.querySelector === 'function'
          && node.querySelector('[data-turn-tail],' + CHIP_SELECTOR + ',' + PILL_SELECTOR) !== null;
      }

      function onMutations(records) {
        if (holders === 0) return;
        for (var i = 0; i < records.length; i += 1) {
          var added = records[i].addedNodes;
          var removed = records[i].removedNodes;
          var j;
          for (j = 0; j < added.length; j += 1) if (affected(added[j])) { sync(); return; }
          for (j = 0; j < removed.length; j += 1) if (affected(removed[j])) { sync(); return; }
        }
      }

      return {
        attach: function () {
          holders += 1;
          if (observer === null && typeof window.MutationObserver === 'function') {
            observer = new window.MutationObserver(onMutations);
            observer.observe(document.body, { childList: true, subtree: true });
          }
        },
        update: function (value) {
          data = value;
          if (holders > 0) sync();
        },
        /** Connect the owning component's dialog actions (null-safe when absent). */
        bridge: function (value) { handlers = value; },
        /** Mark which turn's chip is showing its dialog (drives `aria-expanded`). */
        setActive: function (turn) {
          activeTurn = turn === null || turn === undefined ? null : String(turn);
          var chips = document.querySelectorAll(CHIP_SELECTOR);
          for (var i = 0; i < chips.length; i += 1) {
            var on = chips[i].getAttribute(CHIP_ATTR) === activeTurn ? 'true' : 'false';
            if (chips[i].getAttribute('aria-expanded') !== on) chips[i].setAttribute('aria-expanded', on);
          }
        },
        detach: function () {
          holders -= 1;
          if (holders > 0) return;
          if (observer !== null) { observer.disconnect(); observer = null; }
          data = null;
          activeTurn = null;
          sync();
        }
      };
    }

    var turnCostChips = createTurnCostChips();

    /**
     * Keep the chat's per-turn cost chips in step with the `sessionCost` projection
     * while this session view is mounted. `rev` (locale revision) is a dependency
     * so a language switch rewrites the chip's aria-label / title as well.
     * @param cost - current projection value (`undefined` when the Host is absent).
     * @param bridge - stable `{open(turn, chip), close()}` for the chip's dialog.
     * @param rev - locale revision driving a decorative re-sync.
     */
    function useTurnCostChips(cost, bridge, rev) {
      React.useEffect(function () {
        turnCostChips.attach();
        return function () { turnCostChips.detach(); };
      }, []);
      React.useEffect(function () { turnCostChips.update(cost); }, [cost, rev]);
      React.useEffect(function () { turnCostChips.bridge(bridge); }, [bridge]);
    }

    function ModelRow(props) {
      var m = props.model;
      var sym = props.sym;
      // 说明来自配置文件里的 LocalizedText（Host 原样下发），按当前语言解析；
      // 未标价行没有说明，由「未配置价格」本身交代。
      var note = m.priced ? pickLocalized(m.note) : null;
      return h('div', { className: 'sessionBilling_model' },
        h('div', { className: 'sessionBilling_modelHead' },
          h('span', { className: 'sessionBilling_modelName', title: m.model }, m.label),
          m.tiered ? h('span', { className: 'sessionBilling_badge' }, t('badgePeakIdle')) : null,
          h('span', { className: 'sessionBilling_modelSpacer' }),
          h('span', { className: 'sessionBilling_modelCost' }, m.priced ? fmtCost(m.cost, sym) : t('unpriced'))
        ),
        h('div', { className: 'sessionBilling_meta' }, t('calls', { n: m.calls })),
        note ? h('div', { className: 'sessionBilling_note' }, note) : null
      );
    }

    /** Shared panel body: title + total, per-model rows, estimate footer. */
    function CostPanel(props) {
      var title = props.title;
      var total = props.total;
      var models = props.models;
      var sym = props.sym;
      return [
        h('div', { className: 'sessionBilling_title', key: 'title' },
          h(Icon, { sym: sym }), h('span', null, title),
          h('span', { className: 'sessionBilling_titleSpacer' }),
          h('span', { className: 'sessionBilling_titleValue' }, total)
        ),
        h('div', { className: 'sessionBilling_rule', key: 'rule', 'aria-hidden': true }),
        h('div', { className: 'sessionBilling_notes', key: 'byModel', style: { marginTop: '0' } }, t('byModel')),
        models.map(function (m) {
          return h(ModelRow, { key: m.provider + ' ' + m.model, model: m, sym: sym });
        }),
        h('div', { className: 'sessionBilling_notes', key: 'estimate' },
          h('span', null, t('estimate'))
        )
      ];
    }

    function CostPill(props) {
      var useProjection = props.useProjection;
      var dialog = useDialog();
      var turnDialog = useTurnDialog();
      var cost = useProjection ? useProjection('sessionCost') : undefined;
      var hasCost = !!(cost && Array.isArray(cost.models) && cost.models.length > 0);
      var turnBridge = React.useMemo(function () {
        return { open: turnDialog.open, close: turnDialog.close };
      }, [turnDialog.open, turnDialog.close]);
      // Hooks must run before the early return; the chip decorator lives here because
      // this component is always mounted for an open session. `rev` re-renders on a
      // language switch (t() reads the active locale at call time).
      var rev = useLocaleRevision();
      useTurnCostChips(hasCost ? cost : undefined, turnBridge, rev);
      React.useEffect(function () {
        turnCostChips.setActive(turnDialog.current ? turnDialog.current.turn : null);
      }, [turnDialog.current]);
      if (!hasCost) return null;
      var sym = currencySymbol(cost.currency || 'CNY');
      var turn = turnDialog.current;
      var turnEntry = turn && cost.turns ? cost.turns[turn.turn] : undefined;
      var turnBody = turnEntry ? h('div', {
        ref: turnDialog.panelRef,
        className: 'sessionBilling_panel',
        role: 'dialog',
        'aria-label': t('turnTitle'),
        style: turnDialog.pos ? { top: turnDialog.pos.top, left: turnDialog.pos.left } : { top: 0, left: 0, visibility: 'hidden' }
      }, h(CostPanel, {
        title: t('turnTitle'),
        // Same rule as the session panel: an unpriced turn reads ¥0, the model rows explain it.
        total: fmtCost(turnEntry.cost, sym),
        models: turnEntry.models || [],
        sym: sym
      })) : null;
      var body = h('div', {
        ref: dialog.panelRef,
        className: 'sessionBilling_panel',
        role: 'dialog',
        'aria-label': t('title'),
        style: dialog.pos ? { top: dialog.pos.top, left: dialog.pos.left } : { top: 0, left: 0, visibility: 'hidden' }
      }, h(CostPanel, {
        title: t('title'),
        total: fmtCost(cost.totalCost, sym),
        models: cost.models,
        sym: sym
      }));

      return h(React.Fragment, null,
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'sessionBilling_root', 'data-session-billing': true },
          h('span', { ref: dialog.rootRef, className: 'sessionBilling_anchor' },
            h('button', {
              type: 'button',
              className: 'sessionBilling_pill',
              'aria-haspopup': 'dialog',
              'aria-expanded': dialog.open,
              'aria-label': t('title') + ': ' + fmtCost(cost.totalCost, sym),
              onClick: dialog.toggle
            }, h(Icon, { sym: sym }), h('span', null, fmtCost(cost.totalCost, sym))),
            dialog.open ? (createPortal ? createPortal(body, document.body) : body) : null,
            turnBody ? (createPortal ? createPortal(turnBody, document.body) : turnBody) : null
          )
        )
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // locale 服务是软依赖：拿不到就用内置查表兜底（不因此拒载整个插件）。
        try {
          localeFace = (typeof ctx.get === 'function' ? ctx.get('locale') : null) || ctx.locale || null;
        } catch (_) {
          localeFace = null;
        }
        if (localeFace) {
          var disposers = [];
          ['en', 'zh'].forEach(function (lang) {
            // 重复注册（同 ns+locale 单属主）会抛——热重载重跑时旧字典往往还在，
            // 照常 bind 即可；真正的缺典表现为界面出现 key 本身。
            try { disposers.push(localeFace.register(NS, lang, DICT[lang])); } catch (_) {}
          });
          try { t = localeFace.bind(NS) || t; } catch (_) {}
          if (disposers.length > 0 && typeof ctx.effect === 'function') {
            ctx.effect(function () {
              return function () {
                for (var i = 0; i < disposers.length; i += 1) disposers[i]();
                if (t !== localT) t = localT;
              };
            }, 'session-billing locale dictionaries');
          }
        }
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'session-billing',
            order: 7,
            // 列表标签写成 thunk：每次读取时解析，跟随应用语言，无需重注册。
            label: function () { return t('title'); }
          }, CostPill);
        });
      }
    };
  }
});
