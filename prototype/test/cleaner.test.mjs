import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;
global.document = dom.window.document;

const { cleanConfluenceHtml, analyzeHtml } = await import('../src/cleaner.js');
const { SAMPLE_CONFLUENCE_HTML, SAMPLE_SH_TABLE_HTML } = await import('../src/sample.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail); }
}

const cleaned = cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML);
const s = analyzeHtml(cleaned);
console.log('\n--- cleaned stats ---');
console.log(JSON.stringify(s, null, 2));
console.log('\n--- cleaned html (first 600 chars) ---');
console.log(cleaned.slice(0, 600));

check('标题总数 = 6 (h1,h2x3,h3,h4)', s.headings.total === 6, JSON.stringify(s.headings));
check('代码块 = 2', s.codeBlocks.length === 2, JSON.stringify(s.codeBlocks));
check('代码块1 语言 = java', s.codeBlocks[0] && s.codeBlocks[0].lang === 'java', JSON.stringify(s.codeBlocks[0]));
check('代码块2 语言 = sql', s.codeBlocks[1] && s.codeBlocks[1].lang === 'sql', JSON.stringify(s.codeBlocks[1]));
check('代码块无高亮 span 残留', !/<span[^>]*class="token/.test(cleaned));
check('代码内容完整 (PaymentApplication)', cleaned.includes('PaymentApplication'));
check('表格 = 1', s.tables.length === 1, JSON.stringify(s.tables));
check('表格行数 = 5', s.tables[0] && s.tables[0].rows === 5, JSON.stringify(s.tables[0]));
check('表头单元格 = 4 (1合并+3列头)', s.tables[0] && s.tables[0].headerCells === 4, JSON.stringify(s.tables[0]));
check('合并单元格 = 2 (colspan3 + rowspan2)', s.mergedCells === 2, 'merged=' + s.mergedCells);
check('confluence 类名已剥除', !/confluence(Th|Td|Table)/.test(cleaned));
check('任务项 = 2, 已勾 = 1', s.taskItems === 2 && s.taskChecked === 1, `task=${s.taskItems} checked=${s.taskChecked}`);
check('列表最大深度 >= 3', s.maxListDepth >= 3, 'depth=' + s.maxListDepth);
check('链接 = 1', s.links === 1, 'links=' + s.links);
check('图片 = 1 且标记为 Confluence 附件', s.images.length === 1 && s.images[0].confluence === true, JSON.stringify(s.images));
check('面板降级为引用块 (blockquote >= 3: 2面板+1引用)', s.blockquotes >= 3, 'bq=' + s.blockquotes);
check('分割线 = 1', s.hrs === 1, 'hr=' + s.hrs);
check('行内代码 >= 3', s.inlineCode >= 3, 'inline=' + s.inlineCode);
check('无 script/style 残留', !/<(script|style)/.test(cleaned));
check('无未知标签', s.unknownTags.length === 0, JSON.stringify(s.unknownTags));

check('列宽 colgroup 保留', cleaned.includes('<col') && cleaned.includes('width="40%"'), cleaned.slice(0, 400));
check('表头有字计数 = 表头总数', s.tables[0] && s.tables[0].headerTextCells === s.tables[0].headerCells, JSON.stringify(s.tables[0]));

// ---- 形态二：SyntaxHighlighter 表格型代码块（用户真实文档回归） ----
console.log('\n--- 形态二：SyntaxHighlighter 表格型代码块 ---');
const cleaned2 = cleanConfluenceHtml(SAMPLE_SH_TABLE_HTML);
const s2 = analyzeHtml(cleaned2);
console.log(cleaned2);
check('SH: 代码块 = 1', s2.codeBlocks.length === 1, JSON.stringify(s2.codeBlocks));
check('SH: 语言 = sql', s2.codeBlocks[0] && s2.codeBlocks[0].lang === 'sql', JSON.stringify(s2.codeBlocks[0]));
check('SH: 代码行数 = 3', s2.codeBlocks[0] && s2.codeBlocks[0].lines === 3, JSON.stringify(s2.codeBlocks[0]));
check('SH: 不产生内容表格', s2.tables.length === 0, JSON.stringify(s2.tables));
check('SH: 行号列被丢弃（无 123 串）', !cleaned2.includes('>123<') && !cleaned2.includes('123</div>'), cleaned2.slice(0, 200));
check('SH: 逐词 code 已合并（行内代码 = 0）', s2.inlineCode === 0, 'inline=' + s2.inlineCode);
check('SH: 代码文本完整', cleaned2.includes('user_login_table') && cleaned2.includes('group by user_id') || cleaned2.includes('group') && cleaned2.includes('user_id'), cleaned2.slice(0, 300));
check('SH: 后续正文保留', cleaned2.includes('代码块后面的正文'));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
