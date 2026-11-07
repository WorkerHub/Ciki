import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
try { global.navigator = dom.window.navigator; } catch { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }); }
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.MutationObserver = dom.window.MutationObserver;
global.DOMRect = class { constructor(){ this.x=0;this.y=0;this.width=0;this.height=0;this.top=0;this.left=0;this.bottom=0;this.right=0; } };
if (dom.window.document) {
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x:0,y:0,width:0,height:0,top:0,left:0,bottom:0,right:0 });
  if (dom.window.HTMLElement) dom.window.HTMLElement.prototype.getClientRects = () => [];
}

const { Editor } = await import('@tiptap/core');
const StarterKit = (await import('@tiptap/starter-kit')).default;
const Table = (await import('@tiptap/extension-table')).default;
const TableRow = (await import('@tiptap/extension-table-row')).default;
const TableHeader = (await import('@tiptap/extension-table-header')).default;
const TableCell = (await import('@tiptap/extension-table-cell')).default;
const TaskList = (await import('@tiptap/extension-task-list')).default;
const TaskItem = (await import('@tiptap/extension-task-item')).default;
const Image = (await import('@tiptap/extension-image')).default;
const Link = (await import('@tiptap/extension-link')).default;
const Underline = (await import('@tiptap/extension-underline')).default;
const { cleanConfluenceHtml, analyzeHtml } = await import('../src/cleaner.js');
const { SAMPLE_CONFLUENCE_HTML, SAMPLE_SH_TABLE_HTML } = await import('../src/sample.js');

const cleaned = cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML);
const before = analyzeHtml(cleaned);

const editor = new Editor({
  element: document.getElementById('editor'),
  extensions: [StarterKit, Underline, Link.configure({ openOnClick: false }), Image, Table.configure({ resizable: true }), TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: true })],
  content: cleaned,
});
const out = editor.getHTML();
const after = analyzeHtml(out);
console.log('--- before ---'); console.log(JSON.stringify(before));
console.log('--- after (TipTap getHTML) ---'); console.log(JSON.stringify(after));
console.log('--- out html ---'); console.log(out.slice(0, 1200));

let pass = 0, fail = 0;
function check(name, cond, detail='') { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail); } }
check('标题总数一致', before.headings.total === after.headings.total, `${before.headings.total} -> ${after.headings.total}`);
check('代码块数量+语言一致', before.codeBlocks.length === after.codeBlocks.length && before.codeBlocks.every((c,i)=>after.codeBlocks[i]&&c.lang===after.codeBlocks[i].lang), JSON.stringify(after.codeBlocks));
check('表格数量一致', before.tables.length === after.tables.length);
check('合并单元格一致', before.mergedCells === after.mergedCells, `${before.mergedCells} -> ${after.mergedCells}`);
check('任务项一致', before.taskItems === after.taskItems, `${before.taskItems} -> ${after.taskItems}`);
check('链接一致', before.links === after.links, `${before.links} -> ${after.links}`);
check('图片一致', before.images.length === after.images.length, `${before.images.length} -> ${after.images.length}`);
check('列表深度一致', before.maxListDepth === after.maxListDepth, `${before.maxListDepth} -> ${after.maxListDepth}`);
editor.commands.setContent(cleanConfluenceHtml(SAMPLE_SH_TABLE_HTML));
const shAfter = analyzeHtml(editor.getHTML());
check('SH回读: 代码块 = 1 且语言 sql', shAfter.codeBlocks.length === 1 && shAfter.codeBlocks[0].lang === 'sql', JSON.stringify(shAfter.codeBlocks));
check('SH回读: 无表格', shAfter.tables.length === 0, JSON.stringify(shAfter.tables));
check('SH回读: 行内代码 = 0', shAfter.inlineCode === 0, 'inline=' + shAfter.inlineCode);
console.log(`\n回读结果: ${pass} 通过, ${fail} 失败`);
editor.destroy();
process.exit(fail ? 1 : 0);
