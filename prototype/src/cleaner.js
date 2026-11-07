// Confluence 粘贴清洗管线（原型 v0.1）
// 输入：剪贴板 text/html；输出：可被 TipTap Schema 无损吃下的干净 HTML。
// 原则：保结构（标题/代码/表格合并/列表层级/任务），剥 Confluence 垃圾属性与高亮 span。

function parseFragment(html) {
  const doc = new DOMParser().parseFromString(
    '<!doctype html><html><body><div id="__root">' + html + '</div></body></html>',
    'text/html'
  );
  return doc.getElementById('__root');
}

function extractPreText(pre) {
  // 代码块取纯文本：<br> 换行、.line 分行、其余取 textContent
  const clone = pre.cloneNode(true);
  clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  const lines = clone.querySelectorAll('.line, .code-line');
  if (lines.length > 1) {
    return Array.from(lines).map((l) => l.textContent).join('\n');
  }
  return clone.textContent.replace(/\u00a0/g, ' ');
}

function detectLang(pre) {
  const candidates = [
    pre.getAttribute('data-syntaxhighlighter-params') || '',
    pre.getAttribute('class') || '',
    pre.getAttribute('data-language') || '',
  ];
  const code = pre.querySelector('code');
  if (code) candidates.push(code.getAttribute('class') || '');
  const joined = candidates.join(' ');
  let m = joined.match(/brush:\s*([\w+-]+)/i);
  if (m) return m[1].toLowerCase();
  m = joined.match(/language-([\w+-]+)/i);
  if (m) return m[1].toLowerCase();
  return '';
}

const PANEL_LABELS = [
  { match: 'information', label: 'ℹ️ 提示' },
  { match: 'note', label: '📝 注意' },
  { match: 'warning', label: '⚠️ 警告' },
  { match: 'success', label: '✅ 提示' },
  { match: 'tip', label: '✅ 提示' },
  { match: 'error', label: '⛔ 错误' },
];

export function cleanConfluenceHtml(html) {
  if (!html || !html.trim()) return '';
  // 纯文本粘贴
  if (!/<[a-z][\s\S]*>/i.test(html)) {
    const div = document.createElement('div');
    div.textContent = html.trim();
    return '<p>' + div.innerHTML.replace(/\n/g, '<br>') + '</p>';
  }
  const root = parseFragment(html);
  const doc = root.ownerDocument;

  // 1) 删除危险/无用元素
  root.querySelectorAll('script,style,meta,link,title,noscript,iframe,object,embed,form,head').forEach((el) => el.remove());

  // 2) 信息面板宏 -> blockquote（降级，必须在 div 解包之前）
  root.querySelectorAll('div').forEach((div) => {
    const cls = div.getAttribute('class') || '';
    if (!cls.includes('confluence-information-macro')) return;
    const panel = PANEL_LABELS.find((p) => cls.includes(p.match)) || PANEL_LABELS[0];
    const bq = doc.createElement('blockquote');
    const head = doc.createElement('p');
    const strong = doc.createElement('strong');
    strong.textContent = panel.label;
    head.appendChild(strong);
    bq.appendChild(head);
    // 面板正文通常在 .confluence-information-macro-body 里
    const body = div.querySelector('.confluence-information-macro-body') || div;
    Array.from(body.childNodes).forEach((n) => bq.appendChild(n.cloneNode(true)));
    div.replaceWith(bq);
  });

  // 2.5) SyntaxHighlighter 表格型代码块（从 Confluence 阅读页复制时是这种形态）：
  // <div class="syntaxhighlighter sql"><table><tr><td class="gutter">行号</td>
  // <td class="code"><div class="line"><code class="sql keyword">with</code> <code class="sql plain">x</code></div>…</td></tr></table></div>
  // 必须整块转成一个 <pre>：丢行号列、逐行取纯文本、逐词 <code> 合并。否则行号会被挤成一串、代码会变成满屏行内代码药丸。
  const SH_IGNORE = new Set(['syntaxhighlighter', 'nogutter', 'gutter', 'printing', 'collapsed', 'expanded', 'wrappable', 'scrollbar']);
  function convertShBlock(blockEl, tableEl) {
    const scope = tableEl || blockEl;
    const codeCell = scope.querySelector('td.code') || scope;
    let lang = '';
    (blockEl.getAttribute('class') || '').split(/\s+/).forEach((c) => { if (c && !SH_IGNORE.has(c) && !lang) lang = c.toLowerCase(); });
    if (!lang) {
      const firstCode = codeCell.querySelector('code');
      if (firstCode) lang = ((firstCode.getAttribute('class') || '').split(/\s+/)[0] || '').toLowerCase();
    }
    const lines = codeCell.querySelectorAll('.line');
    let text;
    if (lines.length) text = Array.from(lines).map((l) => l.textContent.replace(/\u00a0/g, ' ')).join('\n');
    else text = codeCell.textContent.replace(/\u00a0/g, ' ');
    const np = doc.createElement('pre');
    const code = doc.createElement('code');
    if (lang && /^[a-z0-9+#-]+$/.test(lang)) code.setAttribute('class', 'language-' + lang);
    code.textContent = text.replace(/\n+$/, '');
    np.appendChild(code);
    (tableEl || blockEl).replaceWith(np);
  }
  root.querySelectorAll('.syntaxhighlighter').forEach((el) => {
    if (el.tagName === 'PRE') return; // syntaxhighlighter-pre 是编辑器形态，走第 3 步
    convertShBlock(el, el.querySelector('table'));
  });
  // 兜底：包装 div 丢失、只剩带 gutter 列的表格
  root.querySelectorAll('td.gutter').forEach((td) => {
    const table = td.closest('table');
    if (table) convertShBlock(table, table);
  });

  // 3) 代码块：剥高亮 span，提取语言，重建 <pre><code>
  root.querySelectorAll('pre').forEach((pre) => {
    const lang = detectLang(pre);
    const text = extractPreText(pre).replace(/\n+$/, '');
    const np = doc.createElement('pre');
    const code = doc.createElement('code');
    if (lang) code.setAttribute('class', 'language-' + lang);
    code.textContent = text;
    np.appendChild(code);
    pre.replaceWith(np);
  });

  // 4) 任务列表 -> TipTap TaskList 结构
  root.querySelectorAll('ul').forEach((ul) => {
    const cls = ul.getAttribute('class') || '';
    const isTask = cls.includes('task') || ul.querySelector('li[data-task-status], li.task-list-item');
    if (!isTask) return;
    ul.setAttribute('data-type', 'taskList');
    ul.querySelectorAll('li').forEach((li) => {
      const status = (li.getAttribute('data-task-status') || '').toLowerCase();
      const classes = (li.getAttribute('class') || '').toLowerCase().split(/\s+/);
      const checked = status === 'complete' || classes.includes('checked') || classes.includes('complete') || !!li.querySelector('input[type="checkbox"][checked]');
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', checked ? 'true' : 'false');
      li.querySelectorAll('input[type="checkbox"], .task-status, span.placeholder-inline-tasks').forEach((el) => el.remove());
    });
  });

  // 5) 图片标记：附件图打标（转存问题要在报告里暴露）
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (/\/download\/attachments\/|confluence/i.test(src)) img.setAttribute('data-confluence-img', 'true');
  });

  // 6) 表格：保留 colgroup 列宽（v0.4，用户反馈表格不应默认撑满行宽）：
  // 把 col 的 style width 归一为 width 属性，只接受 px / % 数值。
  root.querySelectorAll('col').forEach((col) => {
    const style = col.getAttribute('style') || '';
    const m = style.match(/width\s*:\s*([\d.]+(?:px|%))/i);
    const w = col.getAttribute('width') || (m ? m[1] : '');
    if (/^[\d.]+(px|%)$/.test(w)) col.setAttribute('width', w); else col.removeAttribute('width');
    col.removeAttribute('style');
  });

  // 7) 属性白名单清洗
  const ALLOWED = {
    A: ['href', 'title'],
    IMG: ['src', 'alt', 'title', 'width', 'height', 'data-confluence-img'],
    TD: ['colspan', 'rowspan'],
    TH: ['colspan', 'rowspan'],
    COL: ['width'],
    CODE: ['class'],
    UL: ['data-type'],
    LI: ['data-type', 'data-checked'],
  };
  root.querySelectorAll('*').forEach((el) => {
    const keep = ALLOWED[el.tagName] || [];
    Array.from(el.attributes || []).forEach((attr) => {
      if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
      if (el.tagName === 'CODE' && attr.name === 'class' && !/^language-[\w+-]+$/.test(attr.value)) el.removeAttribute('class');
    });
  });

  // 8) 解包无语义容器：div/section/article/span/font/center/figure
  // 反复执行直到没有可解包元素（处理嵌套）
  for (let round = 0; round < 8; round++) {
    let changed = false;
    root.querySelectorAll('div,section,article,figure,center,font,button').forEach((el) => {
      if (!el.parentNode) return;
      Array.from(el.childNodes).forEach((n) => el.parentNode.insertBefore(n, el));
      el.remove();
      changed = true;
    });
    root.querySelectorAll('span').forEach((el) => {
      if (!el.parentNode) return;
      Array.from(el.childNodes).forEach((n) => el.parentNode.insertBefore(n, el));
      el.remove();
      changed = true;
    });
    if (!changed) break;
  }

  // 9) 清理空段落（保留单个空行结构：连续空段只留一个）
  root.querySelectorAll('p').forEach((p) => {
    if (!p.textContent.trim() && !p.querySelector('img,br,hr')) p.remove();
  });

  return root.innerHTML.trim();
}

export function analyzeHtml(html) {
  const stats = {
    headings: { total: 0, byLevel: {} },
    paragraphs: 0,
    codeBlocks: [],
    inlineCode: 0,
    tables: [],
    mergedCells: 0,
    links: 0,
    images: [],
    taskItems: 0,
    taskChecked: 0,
    listItems: 0,
    maxListDepth: 0,
    blockquotes: 0,
    hrs: 0,
    unknownTags: [],
  };
  if (!html || !html.trim()) return stats;
  const root = parseFragment(html);
  const allowed = new Set(['P','H1','H2','H3','H4','H5','H6','PRE','CODE','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','UL','OL','LI','BLOCKQUOTE','HR','BR','IMG','A','STRONG','B','EM','I','U','S','DEL','STRIKE','SUB','SUP','SPAN','DIV','COLGROUP','COL','LABEL','INPUT']);
  const seenUnknown = new Set();
  root.querySelectorAll('*').forEach((el) => {
    if (!allowed.has(el.tagName) && !seenUnknown.has(el.tagName)) { seenUnknown.add(el.tagName); stats.unknownTags.push(el.tagName); }
  });
  for (let i = 1; i <= 6; i++) {
    const n = root.querySelectorAll('h' + i).length;
    if (n) { stats.headings.byLevel['h' + i] = n; stats.headings.total += n; }
  }
  stats.paragraphs = root.querySelectorAll('p').length;
  root.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    const cls = (code && code.getAttribute('class')) || '';
    const m = cls.match(/language-([\w+-]+)/);
    stats.codeBlocks.push({ lang: m ? m[1] : '(无语言)', lines: (pre.textContent.match(/\n/g) || []).length + 1 });
  });
  stats.inlineCode = Array.from(root.querySelectorAll('code')).filter((c) => !c.closest('pre')).length;
  root.querySelectorAll('table').forEach((t) => {
    const cells = t.querySelectorAll('td,th');
    let merged = 0;
    cells.forEach((c) => {
      const cs = parseInt(c.getAttribute('colspan') || '1', 10);
      const rs = parseInt(c.getAttribute('rowspan') || '1', 10);
      if (cs > 1 || rs > 1) merged++;
    });
    stats.mergedCells += merged;
    const ths = t.querySelectorAll('th');
    const thWithText = Array.from(ths).filter((th) => th.textContent.trim().length > 0).length;
    stats.tables.push({ rows: t.querySelectorAll('tr').length, cells: cells.length, headerCells: ths.length, headerTextCells: thWithText, mergedCells: merged });
  });
  stats.links = root.querySelectorAll('a[href]').length;
  root.querySelectorAll('img').forEach((img) => {
    stats.images.push({ src: img.getAttribute('src') || '', confluence: img.hasAttribute('data-confluence-img') || /\/download\/attachments\//.test(img.getAttribute('src') || '') });
  });
  root.querySelectorAll('li').forEach((li) => {
    stats.listItems++;
    if (li.getAttribute('data-type') === 'taskItem' || li.closest('ul[data-type="taskList"]')) {
      stats.taskItems++;
      if (li.getAttribute('data-checked') === 'true') stats.taskChecked++;
    }
    let depth = 0, node = li.parentElement;
    while (node && node !== root) { if (node.tagName === 'UL' || node.tagName === 'OL') depth++; node = node.parentElement; }
    if (depth > stats.maxListDepth) stats.maxListDepth = depth;
  });
  stats.blockquotes = root.querySelectorAll('blockquote').length;
  stats.hrs = root.querySelectorAll('hr').length;
  return stats;
}
