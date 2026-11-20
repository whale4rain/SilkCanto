const MODEL_PRESETS = {
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  gemini: ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon'],
};

const state = {
  meta: null,
  books: [],
  activeBookId: null,
  activeBookDetail: null,
  route: 'chapters', // projects | chapters | chapter-detail | metrics | ledger | outline | deconstruct | empty
  activeChapterNum: null,
  activeChapterData: null,
  savedChapterContent: '',
  isDirty: false,
  inspectorOpen: false,
  activeJobId: null,
  eventSource: null,
  lastExport: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function countChinese(str) {
  const m = String(str || '').match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function toast(message, type = 'normal') {
  const stack = $('toastStack');
  const el = document.createElement('div');
  el.className = `toast ${type === 'warn' ? 'warn' : ''}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s';
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

async function copyToClipboard(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    toast('复制失败，请手动复制', 'warn');
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function getSelectedProviderConfig() {
  return {
    provider: $('providerSelect').value,
    model: $('modelSelect').value,
    effort: $('effortSelect').value,
  };
}

function syncModelHint() {
  const m = $('modelSelect').value || 'deepseek-flash';
  const eff = $('effortSelect').value || 'low';
  $('modelNavHint').textContent = m;
  $('runModelSummary').textContent = `当前模型：${$('providerSelect').value} / ${m}（思考档位：${eff}）`;
}

function populateModelsForProvider(provider) {
  const sel = $('modelSelect');
  const models = MODEL_PRESETS[provider] || MODEL_PRESETS.deepseek;
  sel.innerHTML = models
    .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
    .join('');
  syncModelHint();
}

function autoResizeEditor() {
  const ta = $('chapterTextarea');
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(560, ta.scrollHeight + 48)}px`;
}

function setDirty(dirty) {
  state.isDirty = dirty;
  $('dirtyIndicator').classList.toggle('hidden', !dirty);
}

function confirmDiscardIfDirty() {
  if (!state.isDirty) return true;
  return window.confirm('当前章节有尚未保存的修改，确定离开吗？');
}

function setInspectorOpen(open) {
  state.inspectorOpen = open;
  $('splitInspector').classList.toggle('hidden', !open);
  $('btnToggleInspector').classList.toggle('active-toggle', open);
  $('btnAlertOpenInspector').classList.toggle('hidden', open);
}

// === Routing ===
function setRoute(route, skipDirtyCheck = false) {
  if (!skipDirtyCheck && state.route === 'chapter-detail' && route !== 'chapter-detail') {
    if (!confirmDiscardIfDirty()) return;
    setDirty(false);
  }

  state.route = route;
  const pages = [
    'route-projects',
    'route-chapters-list',
    'route-chapter-detail',
    'route-metrics',
    'route-ledger',
    'route-outline',
    'route-deconstruct',
    'route-empty',
  ];
  for (const id of pages) $(id).classList.add('hidden');

  const navKey = route === 'chapter-detail' ? 'chapters' : route;
  document.querySelectorAll('.nav-item[data-route]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.route === navKey);
  });

  if (route === 'projects') {
    $('headerTitle').textContent = '概览';
    $('bookHeaderActions').classList.add('hidden');
    $('route-projects').classList.remove('hidden');
    renderProjectsOverview();
    return;
  }

  if (route === 'deconstruct') {
    $('headerTitle').textContent = '拆书';
    $('bookHeaderActions').classList.add('hidden');
    $('route-deconstruct').classList.remove('hidden');
    loadDeconstructReports();
    return;
  }

  if (!state.activeBookDetail) {
    $('headerTitle').textContent = '开始';
    $('bookHeaderActions').classList.add('hidden');
    $('route-empty').classList.remove('hidden');
    return;
  }

  $('headerTitle').textContent = state.activeBookDetail.state.foundation.title;
  // 在专注编辑页隐藏顶栏全局主按钮，避免与编辑工具栏的「放行 Commit」争抢主视觉焦点
  $('bookHeaderActions').classList.toggle('hidden', route === 'chapter-detail');

  if (route === 'chapters') $('route-chapters-list').classList.remove('hidden');
  else if (route === 'chapter-detail') $('route-chapter-detail').classList.remove('hidden');
  else if (route === 'metrics') $('route-metrics').classList.remove('hidden');
  else if (route === 'ledger') $('route-ledger').classList.remove('hidden');
  else if (route === 'outline') $('route-outline').classList.remove('hidden');
}

// === Live Jobs (Non-blocking Strip + Optional Log Drawer) ===
function appendLog(line) {
  const pre = $('consoleOutput');
  pre.textContent += `${line}\n`;
  pre.scrollTop = pre.scrollHeight;
}

function setConsoleState(status, label) {
  $('consoleDot').className = `status-dot ${status}`;
  $('consoleStatus').textContent = label;
}

function updateJobStripFromLog(line) {
  const clean = line.trim();
  if (!clean) return;
  if (clean.startsWith('[第') || clean.startsWith('✔') || clean.startsWith('⚠')) {
    $('activeJobText').textContent = clean;
    $('consoleStatus').textContent = clean;
  }
}

async function startJob(payload, onDone) {
  if (state.activeJobId) {
    toast('已有任务正在运行，请等待完成或先停止当前任务', 'warn');
    return;
  }

  $('activeJobBar').classList.remove('hidden');
  $('activeJobText').textContent = `正在启动 ${payload.type}…`;
  setConsoleState('running', `运行中 · ${payload.type}`);
  appendLog(`\n--- ${payload.type} ---`);

  const { jobId } = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ ...getSelectedProviderConfig(), ...payload }),
  });
  state.activeJobId = jobId;

  if (state.eventSource) state.eventSource.close();
  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  state.eventSource = es;

  es.addEventListener('log', (e) => {
    const line = JSON.parse(e.data);
    appendLog(line);
    updateJobStripFromLog(line);
  });

  es.addEventListener('job_done', async (e) => {
    const info = JSON.parse(e.data);
    state.activeJobId = null;
    $('activeJobBar').classList.add('hidden');
    setConsoleState('ok', '已完成');
    es.close();
    state.eventSource = null;
    toast('任务执行完成');
    if (onDone) await onDone(info.result);
  });

  es.addEventListener('job_error', (e) => {
    const info = JSON.parse(e.data);
    state.activeJobId = null;
    $('activeJobBar').classList.add('hidden');
    setConsoleState('warn', '执行失败');
    appendLog(`错误：${info.error || '未知错误'}`);
    es.close();
    state.eventSource = null;
    toast(`任务失败：${info.error || '请查看日志'}`, 'warn');
  });

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return;
    state.activeJobId = null;
    $('activeJobBar').classList.add('hidden');
    setConsoleState('warn', '连接中断');
    es.close();
  };
}

// === Meta & Books ===
async function loadMeta() {
  const meta = await api('/api/meta');
  state.meta = meta;

  const prefer = meta.providers.deepseek_configured ? 'deepseek' : 'gemini';
  $('providerSelect').value = prefer;
  populateModelsForProvider(prefer);

  $('newBookRecipe').innerHTML = meta.recipes
    .map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.display_name)}</option>`)
    .join('');

  $('refCandidates').innerHTML = (meta.references || [])
    .map((p) => `<option value="${escapeHtml(p)}"></option>`)
    .join('');
  if (meta.references?.length > 0 && !$('deconRefPath').value) {
    $('deconRefPath').value = meta.references[0];
  }
}

async function loadBooks(selectId) {
  const { books } = await api('/api/books');
  state.books = books;
  $('navBooksTotal').textContent = String(books.length);
  renderBookSwitcher();

  if (books.length === 0) {
    state.activeBookId = null;
    state.activeBookDetail = null;
    setRoute(state.route === 'deconstruct' ? 'deconstruct' : 'empty', true);
    return;
  }

  const target = selectId || state.activeBookId || books[0].book_id;
  const valid = books.some((b) => b.book_id === target) ? target : books[0].book_id;
  await selectBook(valid);
}

function renderBookSwitcher() {
  const menu = $('bookSwitcherMenu');
  if (state.books.length === 0) {
    $('switcherLabel').textContent = '暂无作品';
    $('switcherDot').className = 'status-dot idle';
    menu.innerHTML = `<div style="padding:8px;font-size:12px;color:var(--fg-faint);">暂无作品</div>`;
    return;
  }

  const current = state.books.find((b) => b.book_id === state.activeBookId) || state.books[0];
  $('switcherLabel').textContent = current.title;
  $('switcherDot').className = `status-dot ${current.phase === 'NEEDS_REVIEW' ? 'warn' : 'ok'}`;

  menu.innerHTML = state.books
    .map((b) => {
      const dot = b.phase === 'NEEDS_REVIEW' ? 'warn' : 'ok';
      const active = b.book_id === state.activeBookId ? 'active' : '';
      return `
        <button class="switcher-option ${active}" data-book-id="${escapeHtml(b.book_id)}">
          <div class="switcher-opt-title">
            <span class="status-dot ${dot}"></span>
            <span class="switcher-opt-name">${escapeHtml(b.title)}</span>
          </div>
          <div class="switcher-opt-sub">${b.metrics.committed_chapters}/${b.metrics.planned_chapters} 章 · ${b.metrics.final_chars.toLocaleString()} 字</div>
        </button>
      `;
    })
    .join('');

  menu.querySelectorAll('.switcher-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      menu.classList.add('hidden');
      await selectBook(btn.dataset.bookId);
      if (state.route === 'projects' || state.route === 'deconstruct') {
        setRoute('chapters');
      }
    });
  });
}

async function selectBook(bookId) {
  state.activeBookId = bookId;
  const detail = await api(`/api/books/${encodeURIComponent(bookId)}`);
  state.activeBookDetail = detail;
  renderBookSwitcher();
  renderAllBookViews();
  if (state.route === 'empty') setRoute('chapters', true);
  else setRoute(state.route, true);
}

function renderProjectsOverview() {
  if (state.books.length === 0) {
    $('projectsTable').innerHTML = `<div style="color:var(--fg-faint);">暂无作品，点击右上角「新建作品」。</div>`;
    return;
  }
  $('projectsTable').innerHTML = `
    <table class="min-table">
      <thead>
        <tr><th>作品</th><th>配方</th><th class="r">章节</th><th class="r">有效汉字</th><th class="r">缓存命中</th><th class="r">费用</th><th class="r">状态</th></tr>
      </thead>
      <tbody>
        ${state.books
          .map((b) => {
            const dot = b.phase === 'NEEDS_REVIEW' ? 'warn' : 'ok';
            const label = b.phase === 'NEEDS_REVIEW' ? '待审校' : b.phase;
            return `
              <tr class="clickable" data-open-book="${escapeHtml(b.book_id)}">
                <td><strong>${escapeHtml(b.title)}</strong></td>
                <td class="mono" style="font-size:12px;color:var(--fg-muted);">${escapeHtml(b.recipe)}</td>
                <td class="r">${b.metrics.committed_chapters}/${b.metrics.planned_chapters}</td>
                <td class="r">${b.metrics.final_chars.toLocaleString()}</td>
                <td class="r">${b.metrics.cache_hit_rate}%</td>
                <td class="r">¥${b.metrics.total_cost_cny.toFixed(4)}</td>
                <td class="r"><span class="row-status"><span class="status-dot ${dot}"></span>${escapeHtml(label)}</span></td>
              </tr>
            `;
          })
          .join('')}
      </tbody>
    </table>
  `;

  $('projectsTable').querySelectorAll('[data-open-book]').forEach((row) => {
    row.addEventListener('click', async () => {
      await selectBook(row.dataset.openBook);
      setRoute('chapters');
    });
  });
}

function renderAllBookViews() {
  const { state: st, metrics, race_report, race_judge } = state.activeBookDetail;
  $('navChapterCount').textContent = `${metrics.committed_chapters}/${metrics.planned_chapters}`;

  updateSmartPrimaryAction(st, metrics);
  renderChapterList(st, metrics);
  renderMetrics(st, metrics);
  renderLedger(st);
  renderOutline(st, race_report, race_judge);
}

// Context-Aware Primary Button & Smart Defaults
function updateSmartPrimaryAction(st, metrics) {
  const btn = $('btnSmartPrimary');
  const suspended = st.chapters.find((c) => c.status === 'needs_review');
  const nextPending = st.chapters.find((c) => c.status !== 'committed');

  if (suspended) {
    btn.textContent = `精修第 ${suspended.chapter} 章`;
    btn.dataset.action = 'review';
    btn.dataset.target = String(suspended.chapter);
  } else if (metrics.final_chars >= 20000) {
    btn.textContent = '导出签约稿';
    btn.dataset.action = 'export';
  } else if (nextPending) {
    const suggestedTo = Math.min(st.volume_plan.length, nextPending.chapter + 2);
    $('runToChapter').value = String(suggestedTo);
    btn.textContent = `续跑至第 ${suggestedTo} 章`;
    btn.dataset.action = 'run-modal';
  } else {
    btn.textContent = '运行流水线';
    btn.dataset.action = 'run-modal';
  }
}

// === Chapters List ===
function renderChapterList(st, metrics) {
  $('chaptersBookTitle').textContent = st.foundation.title;
  $('chaptersBookMeta').textContent =
    `${st.recipe} · 已回写 ${metrics.committed_chapters}/${metrics.planned_chapters} 章 · ${metrics.final_chars.toLocaleString()} 字 · 缓存命中 ${metrics.cache_hit_rate}% · ¥${metrics.total_cost_cny.toFixed(4)}`;

  // Context banner
  const banner = $('contextBanner');
  const suspended = st.chapters.find((c) => c.status === 'needs_review');
  if (suspended) {
    banner.classList.remove('hidden');
    $('contextBannerDot').className = 'status-dot warn';
    $('contextBannerText').textContent =
      `第 ${suspended.chapter} 章《${suspended.title}》未通过质检并已挂起，可边对照质检边微调后放行。`;
    $('contextBannerAction').textContent = `精修第 ${suspended.chapter} 章 →`;
    $('contextBannerAction').onclick = () => openChapter(suspended.chapter, true);
  } else if (metrics.final_chars >= 20000) {
    banner.classList.remove('hidden');
    $('contextBannerDot').className = 'status-dot ok';
    $('contextBannerText').textContent = `已达番茄 20,000 字签约线（当前 ${metrics.final_chars.toLocaleString()} 字），可直接导出投稿。`;
    $('contextBannerAction').textContent = '导出番茄投稿包';
    $('contextBannerAction').onclick = () => triggerExport();
  } else {
    banner.classList.add('hidden');
  }

  $('chapterRows').innerHTML = st.chapters
    .map((c) => {
      const dot =
        c.status === 'committed'
          ? 'ok'
          : c.status === 'needs_review'
            ? 'warn'
            : 'idle';
      const statusLabel =
        c.status === 'committed'
          ? '已回写'
          : c.status === 'needs_review'
            ? '待审校'
            : '未生成';
      const quickLabel =
        c.status === 'committed'
          ? '复制正文'
          : c.status === 'needs_review'
            ? '去精修'
            : '生成本章';
      return `
        <div class="chapter-row" data-ch="${c.chapter}">
          <span class="row-idx">${String(c.chapter).padStart(2, '0')}</span>
          <span class="row-title">${escapeHtml(c.title)}</span>
          <span class="row-muted">${c.chinese_chars ? c.chinese_chars.toLocaleString() : '—'}</span>
          <span class="row-muted">${c.critic_score ?? '—'}</span>
          <div class="row-right-cell">
            <span class="row-status"><span class="status-dot ${dot}"></span>${statusLabel}</span>
            <button class="row-quick-btn" data-quick="${c.status}" data-ch="${c.chapter}">${quickLabel}</button>
          </div>
        </div>
      `;
    })
    .join('');

  $('chapterRows').querySelectorAll('.chapter-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.row-quick-btn')) return;
      const ch = Number(row.dataset.ch);
      const rec = st.chapters.find((c) => c.chapter === ch);
      openChapter(ch, rec?.status === 'needs_review');
    });
  });

  $('chapterRows').querySelectorAll('.row-quick-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ch = Number(btn.dataset.ch);
      const stKind = btn.dataset.quick;
      if (stKind === 'committed') {
        const data = await api(`/api/books/${encodeURIComponent(state.activeBookId)}/chapters/${ch}`);
        await copyToClipboard(data.content, `已复制第 ${ch} 章正文`);
      } else if (stKind === 'needs_review') {
        openChapter(ch, true);
      } else {
        await startJob(
          { type: 'run', bookId: state.activeBookId, toChapter: ch },
          async () => {
            await loadBooks(state.activeBookId);
            await openChapter(ch, false);
          },
        );
      }
    });
  });
}

// === Focused Chapter Editor ===
async function openChapter(chapterNum, autoOpenInspector = false) {
  if (state.route === 'chapter-detail' && state.activeChapterNum !== chapterNum) {
    if (!confirmDiscardIfDirty()) return;
  }

  state.activeChapterNum = chapterNum;
  const data = await api(
    `/api/books/${encodeURIComponent(state.activeBookId)}/chapters/${chapterNum}`,
  );
  state.activeChapterData = data;
  state.savedChapterContent = data.content || '';
  setDirty(false);

  const total = state.activeBookDetail?.state.chapters.length || 12;
  const title = data.record?.title || `第${chapterNum}章`;
  $('proseKicker').textContent = `CHAPTER ${String(chapterNum).padStart(2, '0')}`;
  $('proseTitle').textContent = title;
  $('pagerLabel').textContent = `${String(chapterNum).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  $('btnPrevChapter').disabled = chapterNum <= 1;
  $('btnNextChapter').disabled = chapterNum >= total;

  $('chapterTextarea').value = data.content || '';
  renderChapterInspector(data);
  setRoute('chapter-detail', true);
  setInspectorOpen(autoOpenInspector);
  autoResizeEditor();
}

function renderChapterInspector(data) {
  const lint = data.lint;
  const kv = $('lintKv');
  const issuesEl = $('lintIssuesList');
  const alertLine = $('chapterAlertLine');

  if (!lint) {
    $('editorStatsInline').textContent = '未生成';
    alertLine.classList.add('hidden');
    kv.innerHTML = `<div class="kv-compact-row"><span>状态</span><span>尚未生成正文</span></div>`;
    issuesEl.innerHTML = '';
  } else {
    const m = lint.metrics;
    const forceTotal = Object.values(m.force_adverb_hits || {}).reduce((a, b) => a + b, 0);
    const bodyTotal = Object.values(m.body_cliche_hits || {}).reduce((a, b) => a + b, 0);
    $('editorStatsInline').textContent =
      `${m.chinese_chars.toLocaleString()} 字 · Linter ${lint.passed ? '通过' : '未过'} (${lint.score})`;

    if (!lint.passed) {
      alertLine.classList.remove('hidden');
      $('chapterAlertText').textContent =
        `Linter 检出 ${lint.issues.length} 项问题（${lint.issues[0]?.message || ''}）`;
    } else {
      alertLine.classList.add('hidden');
    }

    kv.innerHTML = [
      ['判定', lint.passed ? `通过 (${lint.score}/10)` : `未通过 (${lint.score}/10)`],
      ['有效汉字', m.chinese_chars.toLocaleString()],
      ['对话占比', `${(m.dialogue_ratio * 100).toFixed(1)}%`],
      ['舞台剧前缀', `${(m.staged_dialogue_ratio * 100).toFixed(1)}%`],
      ['均段 / 最长', `${m.avg_paragraph_chars} / ${m.max_paragraph_chars} 字`],
      ['剧烈副词 / 生理套话', `${forceTotal} / ${bodyTotal} 次`],
    ]
      .map(([k, v]) => `<div class="kv-compact-row"><span>${k}</span><span>${v}</span></div>`)
      .join('');

    issuesEl.innerHTML =
      lint.issues.length === 0
        ? `<div style="color:var(--ok);">全部规则通过</div>`
        : lint.issues
            .map((i) => `<div class="issue-line">• ${escapeHtml(i.message)}</div>`)
            .join('');
  }

  if (data.critic) {
    const c = data.critic;
    const lines = [
      `总分 ${c.overall_score}/10（一致性 ${c.consistency} · 节奏 ${c.pacing} · 钩子 ${c.hook} · 活人感 ${c.human_feel}）`,
    ];
    if (c.issues?.length) {
      lines.push('', ...c.issues.map((s) => `• ${s}`));
    }
    $('criticBody').textContent = lines.join('\n');
  } else {
    $('criticBody').textContent = '暂无审校记录';
  }

  if (data.beat) {
    $('beatBody').textContent = `目标：${data.beat.core_goal}\n冲突：${data.beat.conflict_target}\n钩子：${data.beat.cliffhanger_hook}`;
  } else {
    $('beatBody').textContent = '暂无细纲';
  }
}

async function saveCurrentChapter(markCommitted) {
  if (!state.activeBookId || !state.activeChapterNum) return;
  const content = $('chapterTextarea').value;
  const res = await api(
    `/api/books/${encodeURIComponent(state.activeBookId)}/chapters/${state.activeChapterNum}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        title: state.activeChapterData?.record?.title,
        content,
        markCommitted,
      }),
    },
  );
  state.savedChapterContent = content;
  setDirty(false);
  state.activeChapterData.lint = res.lint;
  state.activeChapterData.record = res.record;
  renderChapterInspector(state.activeChapterData);

  const detail = await api(`/api/books/${encodeURIComponent(state.activeBookId)}`);
  state.activeBookDetail = detail;
  renderAllBookViews();

  if (markCommitted) {
    toast(`第 ${state.activeChapterNum} 章已保存并人工放行 Commit`);
  } else {
    toast(res.lint.passed ? '已保存 · Linter 复检通过' : `已保存 · Linter 仍有 ${res.lint.issues.length} 项提示`, res.lint.passed ? 'normal' : 'warn');
  }
}

async function triggerExport() {
  if (!state.activeBookId) return;
  const res = await api(`/api/books/${encodeURIComponent(state.activeBookId)}/export`, {
    method: 'POST',
  });
  state.lastExport = res;
  const reached = res.result.totalChineseChars >= 20000;
  $('exportMeta').innerHTML = [
    ['导出章数', `${res.result.chapterFiles.length} 章`],
    ['有效汉字总数', `${res.result.totalChineseChars.toLocaleString()} 字（${reached ? '已达 2 万字签约线' : '距 2 万字还差 ' + (20000 - res.result.totalChineseChars).toLocaleString() + ' 字'}）`],
    ['合并文件', res.result.mergedTxtPath],
    ['分章目录', `${res.result.exportDir}/chapters_txt/`],
  ]
    .map(([k, v]) => `<div class="kv-compact-row"><span>${k}</span><span>${escapeHtml(v)}</span></div>`)
    .join('');
  $('exportModal').classList.remove('hidden');
  toast('番茄投稿包已导出');
}

// === Metrics / Ledger / Outline / Deconstruct ===
function renderMetrics(st, m) {
  $('metricsKpis').innerHTML = [
    { name: '已回写汉字', num: m.final_chars.toLocaleString(), sub: `${m.committed_chapters} / ${m.planned_chapters} 章 · 签约线 20,000` },
    { name: 'Token / 最终汉字比', num: m.tokens_per_char ? `${m.tokens_per_char}x` : '—', sub: `总计 ${m.total_tokens.toLocaleString()} tok` },
    { name: 'Prompt 缓存命中率', num: `${m.cache_hit_rate}%`, sub: `${m.total_cached_tokens.toLocaleString()} / ${m.total_in_tokens.toLocaleString()} 输入` },
    { name: '估算总费用', num: `¥${m.total_cost_cny.toFixed(4)}`, sub: `思考占比 ${m.reasoning_ratio}% · ${(m.total_duration_ms / 1000).toFixed(1)}s` },
  ]
    .map((k) => `<div class="kpi-item"><div class="kpi-name">${k.name}</div><div class="kpi-num">${k.num}</div><div class="kpi-sub">${k.sub}</div></div>`)
    .join('');

  const maxDur = Math.max(1, ...m.stages.map((s) => s.durMs));
  $('stageBars').innerHTML = m.stages
    .map((s) => {
      const pct = Math.max(2, Math.round((s.durMs / maxDur) * 100));
      const cachePct = s.inTok > 0 ? ((s.cachedTok / s.inTok) * 100).toFixed(1) : '0.0';
      return `
        <div>
          <div class="stage-line-top">
            <span><strong>${escapeHtml(s.stage)}</strong> <span style="color:var(--fg-faint);">×${s.calls}</span></span>
            <span style="color:var(--fg-muted);">${(s.durMs / 1000).toFixed(1)}s · 缓存 ${cachePct}% · 思考 ${s.reasonTok.toLocaleString()}</span>
          </div>
          <div class="stage-track"><div class="stage-bar" style="width:${pct}%"></div></div>
        </div>
      `;
    })
    .join('');

  $('chapterMetricsTable').innerHTML = `
    <table class="min-table">
      <thead><tr><th>章节</th><th class="r">汉字</th><th class="r">Token/字</th><th class="r">缓存命中</th><th class="r">耗时</th><th class="r">Critic</th></tr></thead>
      <tbody>
        ${m.chapters
          .map(
            (c) => `
          <tr class="clickable" data-jump-ch="${c.chapter}">
            <td>第 ${c.chapter} 章 · ${escapeHtml(c.title)}</td>
            <td class="r">${c.chinese_chars.toLocaleString()}</td>
            <td class="r">${c.tokens_per_char}x</td>
            <td class="r">${c.cache_hit_rate}%</td>
            <td class="r">${c.duration_ms > 0 ? `${(c.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
            <td class="r">${c.critic_score ?? '—'}</td>
          </tr>
        `,
          )
          .join('')}
      </tbody>
    </table>
  `;

  $('chapterMetricsTable').querySelectorAll('[data-jump-ch]').forEach((tr) => {
    tr.addEventListener('click', () => openChapter(Number(tr.dataset.jumpCh), false));
  });

  const recent = st.cost.calls.slice(-15).reverse();
  $('recentCallsTable').innerHTML = `
    <table class="min-table">
      <thead><tr><th>阶段</th><th>章</th><th>模型</th><th class="r">耗时 / TTFT</th><th class="r">输入 (缓存)</th><th class="r">输出 (思考)</th></tr></thead>
      <tbody>
        ${recent
          .map((c) => {
            const cachePct = c.prompt_tokens > 0 ? `${(((c.cached_input_tokens ?? 0) / c.prompt_tokens) * 100).toFixed(1)}%` : '0%';
            const dur = c.duration_ms ? `${(c.duration_ms / 1000).toFixed(1)}s` : '—';
            const ttft = c.ttft_ms ? ` / ${(c.ttft_ms / 1000).toFixed(1)}s` : '';
            return `
              <tr>
                <td>${escapeHtml(c.stage)}</td>
                <td>${c.chapter ?? '—'}</td>
                <td class="mono" style="font-size:12px;color:var(--fg-muted);">${escapeHtml(c.model)}</td>
                <td class="r">${dur}${ttft}</td>
                <td class="r">${c.prompt_tokens.toLocaleString()} (${cachePct})</td>
                <td class="r">${c.completion_tokens.toLocaleString()} (${c.reasoning_tokens ?? 0})</td>
              </tr>
            `;
          })
          .join('')}
      </tbody>
    </table>
  `;
}

function renderLedger(st) {
  const f = st.foundation;
  $('goldenFingerBlock').innerHTML = `
    <div class="section-label">金手指规则与硬性限制</div>
    <div class="kv-list">
      <div class="kv-row"><strong>${escapeHtml(f.golden_finger_name)}</strong> — ${escapeHtml(f.core_selling_point)}</div>
      <div class="kv-row"><span style="color:var(--fg-muted);">规则：</span>${escapeHtml(f.golden_finger_rules)}</div>
      <div class="kv-row"><span style="color:var(--fg-muted);">限制：</span>${escapeHtml(f.golden_finger_limits)}</div>
    </div>
  `;

  $('truthList').innerHTML = st.author_truth
    .map((t) => `<div class="kv-row"><span class="kv-tag">CH${t.chapter}</span>${escapeHtml(t.fact)}</div>`)
    .join('');

  $('knownList').innerHTML = st.reader_known
    .map((k) => `<div class="kv-row"><span class="kv-tag">CH${k.chapter}</span>${escapeHtml(k.fact)}</div>`)
    .join('');

  $('charactersTable').innerHTML = `
    <table class="min-table">
      <thead><tr><th>姓名</th><th>定位</th><th>当前状态</th><th>与主角关系</th></tr></thead>
      <tbody>
        ${st.characters
          .map((c) => `<tr><td><strong>${escapeHtml(c.name)}</strong></td><td style="color:var(--fg-muted);">${escapeHtml(c.role)}</td><td>${escapeHtml(c.current_status)}</td><td style="color:var(--fg-muted);">${escapeHtml(c.relationship_to_mc)}</td></tr>`)
          .join('')}
      </tbody>
    </table>
  `;

  $('assetsAndFs').innerHTML = `
    <div class="kv-list">
      ${st.foreshadowing
        .map((fs) => `<div class="kv-row"><span class="kv-tag">${escapeHtml(fs.id)} · ${escapeHtml(fs.status)}</span>${escapeHtml(fs.summary)} <span style="color:var(--fg-faint);">→ ${escapeHtml(fs.payoff_plan)}</span></div>`)
        .join('')}
      ${st.assets
        .map((a) => `<div class="kv-row"><span class="kv-tag">道具</span><strong>${escapeHtml(a.name)}</strong>（${escapeHtml(a.owner)} · ${escapeHtml(a.quantity_or_level)}）— ${escapeHtml(a.description)}</div>`)
        .join('')}
    </div>
  `;
}

function renderOutline(st, raceReport, raceJudge) {
  $('outlineMeta').textContent = `${st.foundation.genre} · 规划 ${st.volume_plan.length} 章`;
  $('bookBlurb').textContent = st.foundation.blurb;
  $('titleCandidates').textContent = `备选书名：${(st.foundation.title_candidates || []).join('  /  ')}`;

  const rp = $('racePanel');
  if (raceReport && raceJudge) {
    rp.classList.remove('hidden');
    const btns = (raceJudge.scores || [])
      .map((s) => `<button class="btn ${s.variant_id === raceJudge.winner_id ? 'btn-primary' : 'btn-secondary'}" data-select-var="${escapeHtml(s.variant_id)}">采用 ${escapeHtml(s.variant_id)} (${s.overall_score})</button>`)
      .join(' ');
    rp.innerHTML = `<div class="section-label">黄金三章赛马评审（推荐 ${escapeHtml(raceJudge.winner_id)}）</div><div style="display:flex;gap:8px;margin-bottom:12px;">${btns}</div><pre class="report-pre">${escapeHtml(raceReport)}</pre>`;
    rp.querySelectorAll('[data-select-var]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/api/books/${encodeURIComponent(state.activeBookId)}/select`, {
          method: 'POST',
          body: JSON.stringify({ variantId: btn.dataset.selectVar }),
        });
        toast(`已锁定赛马版本 ${btn.dataset.selectVar}`);
        await selectBook(state.activeBookId);
      });
    });
  } else {
    rp.classList.add('hidden');
  }

  $('volumePlanList').innerHTML = st.volume_plan
    .map(
      (p) => `
      <div class="outline-item">
        <div class="outline-ch">${String(p.chapter).padStart(2, '0')}</div>
        <div>
          <div style="font-weight:500;margin-bottom:4px;">${escapeHtml(p.title)}</div>
          <div style="color:#27272A;margin-bottom:4px;">${escapeHtml(p.summary)}</div>
          <div style="font-size:12px;color:var(--fg-faint);">钩子：${escapeHtml(p.hook_hint)}</div>
        </div>
      </div>
    `,
    )
    .join('');
}

async function loadDeconstructReports() {
  const { items } = await api('/api/deconstruct');
  const el = $('deconstructReports');
  if (items.length === 0) {
    el.innerHTML = `<div style="color:var(--fg-faint);">暂无拆书报告</div>`;
    return;
  }
  el.innerHTML = items
    .map((item) => `<div class="report-block"><div style="font-weight:600;font-size:15px;">${escapeHtml(item.name)}</div><pre class="report-pre">${escapeHtml(item.report)}</pre></div>`)
    .join('');
}

// === Event & Keyboard Wiring ===
function bindEvents() {
  const openEl = (id) => $(id).classList.remove('hidden');
  const closeEl = (id) => $(id).classList.add('hidden');

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => closeEl(el.dataset.close));
  });

  document.querySelectorAll('.nav-item[data-route]').forEach((btn) => {
    btn.addEventListener('click', () => setRoute(btn.dataset.route));
  });

  $('btnAllBooks').addEventListener('click', () => setRoute('projects'));
  $('btnCrumbRoot').addEventListener('click', () => setRoute('projects'));

  // Custom book switcher toggle
  $('bookSwitcherBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('bookSwitcherMenu').classList.toggle('hidden');
  });

  $('providerSelect').addEventListener('change', (e) => populateModelsForProvider(e.target.value));
  $('modelSelect').addEventListener('change', syncModelHint);
  $('effortSelect').addEventListener('change', syncModelHint);

  $('btnOpenModelModal').addEventListener('click', () => openEl('modelModal'));
  $('btnNewBook').addEventListener('click', () => openEl('newBookModal'));
  $('btnProjectsNewBook').addEventListener('click', () => openEl('newBookModal'));
  $('btnEmptyNewBook').addEventListener('click', () => openEl('newBookModal'));

  // Smart Primary Header Action
  $('btnSmartPrimary').addEventListener('click', () => {
    const action = $('btnSmartPrimary').dataset.action;
    if (action === 'review') {
      openChapter(Number($('btnSmartPrimary').dataset.target), true);
    } else if (action === 'export') {
      triggerExport();
    } else {
      syncModelHint();
      openEl('runModal');
    }
  });

  // Popover
  $('btnMoreMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    $('morePopover').classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    $('morePopover').classList.add('hidden');
    $('bookSwitcherMenu').classList.add('hidden');
  });

  $('btnActionRunCustom').addEventListener('click', () => {
    syncModelHint();
    openEl('runModal');
  });

  $('btnActionRace').addEventListener('click', async () => {
    if (!state.activeBookId) return;
    await startJob({ type: 'race', bookId: state.activeBookId, variants: 3 }, async () => {
      await loadBooks(state.activeBookId);
      setRoute('outline');
    });
  });

  $('btnActionExport').addEventListener('click', () => triggerExport());
  $('btnActionRefresh').addEventListener('click', async () => {
    await loadBooks(state.activeBookId);
    toast('已刷新本地数据');
  });

  $('btnConfirmRun').addEventListener('click', async () => {
    if (!state.activeBookId) return;
    closeEl('runModal');
    const toChapter = Number($('runToChapter').value) || 10;
    await startJob({ type: 'run', bookId: state.activeBookId, toChapter }, async () => {
      await loadBooks(state.activeBookId);
    });
  });

  $('btnSubmitNewBook').addEventListener('click', async () => {
    const bookId = $('newBookId').value.trim();
    const idea = $('newBookIdea').value.trim();
    const recipe = $('newBookRecipe').value;
    if (!bookId || !idea) {
      toast('请填写书籍 ID 和核心脑洞', 'warn');
      return;
    }
    closeEl('newBookModal');
    await startJob({ type: 'init', bookId, idea, recipe }, async () => {
      await loadBooks(bookId);
      setRoute('chapters');
    });
  });

  // Job strip controls
  $('btnJobViewLogs').addEventListener('click', () => openEl('logDrawer'));
  $('btnJobCancel').addEventListener('click', async () => {
    if (!state.activeJobId) return;
    await api(`/api/jobs/${state.activeJobId}/cancel`, { method: 'POST' });
    toast('已发送停止请求，将在当前步骤完成后停止');
  });

  // Export modal copy actions
  $('btnCopyExportPath').addEventListener('click', () => {
    if (state.lastExport) copyToClipboard(state.lastExport.result.mergedTxtPath, '已复制文件路径');
  });
  $('btnCopyExportText').addEventListener('click', () => {
    if (state.lastExport) copyToClipboard(state.lastExport.mergedText, '已复制全书纯净正文，可直接粘贴至番茄后台');
  });

  // Chapter editor controls
  $('btnBackToList').addEventListener('click', () => setRoute('chapters'));
  $('btnPrevChapter').addEventListener('click', () => {
    if (state.activeChapterNum > 1) openChapter(state.activeChapterNum - 1, state.inspectorOpen);
  });
  $('btnNextChapter').addEventListener('click', () => {
    const max = state.activeBookDetail?.state.chapters.length || 12;
    if (state.activeChapterNum < max) openChapter(state.activeChapterNum + 1, state.inspectorOpen);
  });
  $('btnToggleInspector').addEventListener('click', () => setInspectorOpen(!state.inspectorOpen));
  $('btnCloseInspector').addEventListener('click', () => setInspectorOpen(false));
  $('btnAlertOpenInspector').addEventListener('click', () => setInspectorOpen(true));

  $('chapterTextarea').addEventListener('input', () => {
    autoResizeEditor();
    const val = $('chapterTextarea').value;
    setDirty(val !== state.savedChapterContent);
    $('editorStatsInline').textContent = `${countChinese(val).toLocaleString()} 字（编辑中）`;
  });

  $('btnCopyChapter').addEventListener('click', () => {
    copyToClipboard($('chapterTextarea').value, `已复制第 ${state.activeChapterNum} 章正文`);
  });

  $('btnSaveChapter').addEventListener('click', () => saveCurrentChapter(false));
  $('btnApproveChapter').addEventListener('click', () => saveCurrentChapter(true));

  $('btnForceRerun').addEventListener('click', async () => {
    if (!state.activeBookId || !state.activeChapterNum) return;
    const ch = state.activeChapterNum;
    await startJob(
      { type: 'run', bookId: state.activeBookId, toChapter: ch, forceChapter: ch },
      async () => {
        await loadBooks(state.activeBookId);
        await openChapter(ch, true);
      },
    );
  });

  // Logs drawer
  $('btnToggleLogs').addEventListener('click', () => openEl('logDrawer'));
  $('btnClearConsole').addEventListener('click', () => {
    $('consoleOutput').textContent = '';
  });

  // Deconstruct
  $('btnDeconStats').addEventListener('click', async () => {
    const refPath = $('deconRefPath').value.trim();
    if (!refPath) return toast('请填写样章路径', 'warn');
    await startJob({ type: 'deconstruct', refPath, statsOnly: true }, (result) => {
      if (result?.quantitative) {
        const q = result.quantitative;
        $('deconQuickStats').classList.remove('hidden');
        $('deconQuickStats').innerHTML = `
          <div class="section-label">定量测节奏结果 · ${escapeHtml(result.sourceName)}</div>
          <div class="kpi-row" style="margin-bottom:0;">
            <div class="kpi-item"><div class="kpi-name">均章汉字</div><div class="kpi-num">${q.avgChineseChars.toLocaleString()}</div><div class="kpi-sub">${q.minChineseChars}–${q.maxChineseChars} 字</div></div>
            <div class="kpi-item"><div class="kpi-name">平均对话占比</div><div class="kpi-num">${(q.avgDialogueRatio * 100).toFixed(1)}%</div><div class="kpi-sub">前 ${q.chapterCount} 章均值</div></div>
            <div class="kpi-item"><div class="kpi-name">均段长度</div><div class="kpi-num">${q.avgParagraphChars}</div><div class="kpi-sub">汉字 / 段</div></div>
            <div class="kpi-item"><div class="kpi-name">短句比例</div><div class="kpi-num">${(q.avgShortSentenceRatio * 100).toFixed(1)}%</div><div class="kpi-sub">≤20 字短句</div></div>
          </div>
        `;
      }
    });
  });

  $('btnDeconFull').addEventListener('click', async () => {
    const refPath = $('deconRefPath').value.trim();
    const outRecipe = $('deconOutRecipe').value.trim();
    if (!refPath) return toast('请填写样章路径', 'warn');
    await startJob({ type: 'deconstruct', refPath, outRecipe }, async () => {
      await loadMeta();
      await loadDeconstructReports();
    });
  });

  // Keyboard Shortcuts (Linear / Raycast style)
  document.addEventListener('keydown', (e) => {
    const isMeta = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      ['runModal', 'modelModal', 'newBookModal', 'exportModal', 'logDrawer'].forEach(closeEl);
      $('morePopover').classList.add('hidden');
      $('bookSwitcherMenu').classList.add('hidden');
      if (state.inspectorOpen) setInspectorOpen(false);
      return;
    }
    if (isMeta && e.key.toLowerCase() === 's' && state.route === 'chapter-detail') {
      e.preventDefault();
      saveCurrentChapter(false);
      return;
    }
    if (isMeta && e.key.toLowerCase() === 'i' && state.route === 'chapter-detail') {
      e.preventDefault();
      setInspectorOpen(!state.inspectorOpen);
      return;
    }
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName || '');
    if (!inField && state.route === 'chapter-detail') {
      if (e.key === '[' && state.activeChapterNum > 1) {
        openChapter(state.activeChapterNum - 1, state.inspectorOpen);
      } else if (e.key === ']') {
        const max = state.activeBookDetail?.state.chapters.length || 12;
        if (state.activeChapterNum < max) openChapter(state.activeChapterNum + 1, state.inspectorOpen);
      }
    }
  });
}

(async function init() {
  bindEvents();
  await loadMeta();
  await loadBooks();
})();
