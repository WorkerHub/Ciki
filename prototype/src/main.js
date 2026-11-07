import { Editor, Extension} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { Plugin} from '@tiptap/pm/state';
import { cleanConfluenceHtml, analyzeHtml} from './cleaner.js';
import { SAMPLE_CONFLUENCE_HTML, SAMPLE_SH_TABLE_HTML } from './sample.js';

const $ = (id) => document.getElementById(id);
let lastRaw = '', lastCleaned = '', lastCleanStats = null;

function fmtStats(s) {
if (!s) return '—';
const heads = Object.entries(s.headings.byLevel).map(([k, v]) => `${k}×${v}`).join(' ') || '无';
const codes = s.codeBlocks.map((c) => `${c.lang}/${c.lines}行`).join(', ') || '无';
const tables = s.tables.map((t) => `${t.rows}行/${t.cells}格/表头${t.headerTextCells}/${t.headerCells}有字/合并${t.mergedCells}`).join(', ') || '无';
return [
`标题: ${s.headings.total}（${heads}）`,
`段落: ${s.paragraphs} 行内代码: ${s.inlineCode}`,
`代码块: ${s.codeBlocks.length}（${codes}）`,
`表格: ${s.tables.length}（${tables}）合并单元格共 ${s.mergedCells}`,
`列表项: ${s.listItems} 最大深度 ${s.maxListDepth} 任务项: ${s.taskItems}（已勾 ${s.taskChecked}）`,
`链接: ${s.links} 引用块: ${s.blockquotes} 分割线: ${s.hrs}`,
`图片: ${s.images.length}` + (s.images.length? '（' + s.images.map((i) => i.confluence? '⚠️Confluence附件': '普通').join(', ') + '）': ''),
s.unknownTags.length? `未知标签: ${s.unknownTags.join(',')}`: '未知标签: 无',
].join('\n');
}

function toast(msg) {
const t = $('toast'); t.textContent = msg; t.style.display = 'block';
setTimeout(() => (t.style.display = 'none'), 2600);
}

function updateImgWarn(stats) {
const bad = (stats? stats.images: []).filter((i) => i.confluence);
const el = $('imgwarn');
if (bad.length) {
el.style.display = 'block';
el.textContent = `⚠️ 有 ${bad.length} 张图是 Confluence 附件链接，未转存：` + bad.map((i) => i.src).join(' ；') + '。这类链接在正式版里会标黄并提供手动上传到 R2 的入口。';
} else el.style.display = 'none';
}

function renderChecks(cleanStats, roundStats) {
const box = $('checks');
if (!cleanStats ||!roundStats) { box.innerHTML = '<div class="check"><span>等待数据</span><span class="na">—</span></div>'; return [];}
const items = [
['标题数量与层级', cleanStats.headings.total === roundStats.headings.total && JSON.stringify(cleanStats.headings.byLevel) === JSON.stringify(roundStats.headings.byLevel)],
['代码块数量与语言', cleanStats.codeBlocks.length === roundStats.codeBlocks.length && cleanStats.codeBlocks.every((c, i) => roundStats.codeBlocks[i] && c.lang === roundStats.codeBlocks[i].lang)],
['表格数量', cleanStats.tables.length === roundStats.tables.length],
['合并单元格 (colspan/rowspan)', cleanStats.mergedCells === roundStats.mergedCells],
['列表最大深度', cleanStats.maxListDepth === roundStats.maxListDepth],
['任务项数量', cleanStats.taskItems === roundStats.taskItems],
['链接数量', cleanStats.links === roundStats.links],
['图片数量', cleanStats.images.length === roundStats.images.length],
['表头文字（有字的表头格/表头格总数）', JSON.stringify(cleanStats.tables.map((t) => [t.headerTextCells, t.headerCells])) === JSON.stringify(roundStats.tables.map((t) => [t.headerTextCells, t.headerCells])) && cleanStats.tables.every((t) => t.headerCells === 0 || t.headerTextCells > 0)],
];
box.innerHTML = items.map(([name, ok]) => `<div class="check"><span>${name}</span><span class="${ok? 'pass': 'fail'}">${ok? '✓ 保住': '✗ 有丢失'}</span></div>`).join('');
return items;
}

let editor;
const PasteCleaner = Extension.create({
name: 'confluencePasteCleaner',
addProseMirrorPlugins() {
return [new Plugin({
props: {
handlePaste(view, event) {
const cd = event.clipboardData;
if (!cd) return false;
const files = Array.from(cd.files || []).filter((f) => f.type.startsWith('image/'));
const html = cd.getData('text/html');
if (files.length &&!html) {
files.forEach((f) => {
const r = new FileReader();
r.onload = () => editor.chain().focus().setImage({ src: r.result}).run();
r.readAsDataURL(f);
});
toast('图片已插入（原型用本地预览模拟 R2 上传）');
return true;
}
if (!html) return false;
lastRaw = html;
const cleaned = cleanConfluenceHtml(html);
lastCleaned = cleaned;
lastCleanStats = analyzeHtml(cleaned);
$('stat-raw').textContent = fmtStats(analyzeHtml(html));
$('stat-clean').textContent = fmtStats(lastCleanStats);
$('raw-html').textContent = html.slice(0, 2000);
updateImgWarn(lastCleanStats);
editor.chain().focus().insertContent(cleaned).run();
toast('已按清洗管线粘贴');
return true;
},
},
})];
},
});

editor = new Editor({
element: $('editor'),
extensions: [
StarterKit.configure({ codeBlock: false }),
CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
Underline,
Link.configure({ openOnClick: false}),
Image,
Table.configure({ resizable: true}),
TableRow, TableHeader, TableCell,
TaskList,
TaskItem.configure({ nested: true}),
PasteCleaner,
],
content: '<p>点这里，直接粘贴 Confluence 内容，或先点上方「载入模拟样本」。</p>',
onUpdate({ editor}) {
const html = editor.getHTML();
const round = analyzeHtml(html);
$('stat-round').textContent = fmtStats(round);
$('json-out').textContent = JSON.stringify(editor.getJSON()).slice(0, 2000);
if (lastCleanStats) renderChecks(lastCleanStats, round);
},
});

function setFromHtml(rawHtml) {
lastRaw = rawHtml;
lastCleaned = cleanConfluenceHtml(rawHtml);
lastCleanStats = analyzeHtml(lastCleaned);
$('stat-raw').textContent = fmtStats(analyzeHtml(rawHtml));
$('stat-clean').textContent = fmtStats(lastCleanStats);
$('raw-html').textContent = rawHtml.slice(0, 2000);
updateImgWarn(lastCleanStats);
editor.commands.setContent(lastCleaned);
}

$('btn-sample').addEventListener('click', () => { setFromHtml(SAMPLE_CONFLUENCE_HTML); toast('模拟样本已载入');});
$('btn-sample2').addEventListener('click', () => { setFromHtml(SAMPLE_SH_TABLE_HTML); toast('样本2（行号列形态）已载入');});
$('btn-clear').addEventListener('click', () => { editor.commands.clearContent(); lastCleanStats = null; $('stat-clean').textContent = '—'; renderChecks(null, null);});

let capturedCleaned = '';
$('capture').addEventListener('paste', (e) => {
e.preventDefault();
const html = e.clipboardData.getData('text/html');
const text = e.clipboardData.getData('text/plain');
const raw = html || text;
lastRaw = raw;
capturedCleaned = cleanConfluenceHtml(raw);
const cs = analyzeHtml(capturedCleaned);
$('stat-raw').textContent = fmtStats(analyzeHtml(raw));
$('stat-clean').textContent = fmtStats(cs);
$('raw-html').textContent = raw.slice(0, 2000);
updateImgWarn(cs);
$('capture').textContent = `已捕获：清洗后标题 ${cs.headings.total}、代码块 ${cs.codeBlocks.length}、表格 ${cs.tables.length}（合并 ${cs.mergedCells}）、任务 ${cs.taskItems}。可点下方按钮放入编辑器，或重新粘贴。`;
$('btn-capture-to-editor').disabled = false;
});
$('btn-capture-to-editor').addEventListener('click', () => { if (capturedCleaned) setFromHtml(lastRaw);});

$('btn-download').addEventListener('click', () => {
const blob = new Blob([editor.getHTML()], { type: 'text/html'});
const a = document.createElement('a');
a.href = URL.createObjectURL(blob); a.download = 'wiki-cleaned.html'; a.click();
URL.revokeObjectURL(a.href);
});

$('btn-report').addEventListener('click', async () => {
const round = analyzeHtml(editor.getHTML());
const items = lastCleanStats? renderChecks(lastCleanStats, round): [];
const manual = Array.from(document.querySelectorAll('.manual-check')).map((c) => `${c.checked? '✓': '✗'} ${c.value}`);
const lines = [
'',
'时间: ' + new Date().toLocaleString('zh-CN'),
'浏览器: ' + navigator.userAgent,
'--- 自动校验（清洗后 → TipTap 回读）---',
...(items.length? items.map(([n, ok]) => `${ok? '✓': '✗'} ${n}`): ['（未载入/未粘贴内容）']),
'--- 统计 ---',
'清洗后: ' + fmtStats(lastCleanStats).replace(/\n/g, ' | '),
'回读: ' + fmtStats(round).replace(/\n/g, ' | '),
'--- 人工目检 ---',
...manual,
'--- 图片警告 ---',
lastCleanStats && lastCleanStats.images.some((i) => i.confluence)? '有 Confluence 附件图未转存（预期行为）': '无',
'（本报告只含计数与勾选，不含文档正文）',
];
const text = lines.join('\n');
try { await navigator.clipboard.writeText(text); toast('测试结果已复制，去粘回对话里就行');}
catch {
const blob = new Blob([text], { type: 'text/plain'});
const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'paste-test-report.txt'; a.click();
toast('已下载测试结果文件');
}
});

renderChecks(null, null);
