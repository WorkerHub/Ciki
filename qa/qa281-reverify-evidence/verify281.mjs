import { chromium } from "playwright-core";
import fs from "node:fs";
import { execSync } from "node:child_process";

// ===== QA #281 复验（Jim）：移动对话框 + PageView 删除对话框 长标题场景 =====
// 被测：main 8679061（PR #323 合入后）。口径：对话框无溢出、标题单行省略号截断、
// 悬停可读完整标题（title 属性）、#279 trigger/dropdown/indent 不回归。

const BASE = "http://localhost:5173";
const DIR = "/tmp/qa281-reverify";
const SHOTS = DIR + "/shots";
fs.mkdirSync(SHOTS, { recursive: true });

const PAGE_E_TITLE =
  "5.0 二级长标题待移动页——移动对话框长标题穿模修复复验用页面标题也是相当的长☆";
const PAGE_F_TITLE = "6.0 短标题回归页";
const EXPECT_MOVE_E = `移动「${PAGE_E_TITLE}」`;
const EXPECT_DEL_E = `删除「${PAGE_E_TITLE}」？`;
const EXPECT_MOVE_F = `移动「${PAGE_F_TITLE}」`;

const cookie = fs
  .readFileSync(DIR + "/cookies.txt", "utf8")
  .split("\n")
  .find((l) => l.includes("ciki_session"));
const sess = cookie.trim().split("\t").pop();

const results = [];
const fails = [];

function assert(m, cond, what) {
  const ok = cond === true || cond === null; // null = 不适用
  if (!ok) fails.push({ case: m.label, what, got: JSON.stringify(cond) });
}

async function setTheme(style) {
  execSync(
    `curl -s -X PUT http://127.0.0.1:8787/api/me/theme-style -b ${DIR}/cookies.txt -H 'Content-Type: application/json' -d '{"themeStyle":"${style}"}'`
  );
}

async function measureDialog(page, m, opts) {
  // opts: { kind: 'dialog'|'alert-dialog', expectTitle, withSelect }
  const kind = opts.kind;
  const d = await page.evaluate(
    ({ kind, withSelect }) => {
      const dlg = document.querySelector(`[data-slot="${kind}-content"]`);
      if (!dlg) return { missing: true };
      const dlgRect = dlg.getBoundingClientRect();
      const dlgCS = getComputedStyle(dlg);
      const title = document.querySelector(`[data-slot="${kind}-title"]`);
      const tRect = title ? title.getBoundingClientRect() : null;
      const tCS = title ? getComputedStyle(title) : null;
      const desc = document.querySelector(
        `[data-slot="${kind === "dialog" ? "dialog-description" : "alert-dialog-description"}"]`
      );
      const footer = document.querySelector(`[data-slot="${kind}-footer"]`);
      const fRect = footer ? footer.getBoundingClientRect() : null;
      // grid 轨道：单列轨道解析宽度 vs 内容盒宽度
      const padL = parseFloat(dlgCS.paddingLeft) || 0;
      const padR = parseFloat(dlgCS.paddingRight) || 0;
      const track = dlgCS.gridTemplateColumns.split(" ").map(parseFloat);
      const contentBoxW = dlg.clientWidth - padL - padR;
      // 触发器（移动对话框才有）
      const trigger = withSelect
        ? document.querySelector("#move-page-parent")
        : null;
      const tRect2 = trigger ? trigger.getBoundingClientRect() : null;
      const value = trigger
        ? trigger.querySelector('[data-slot="select-value"]')
        : null;
      const vCS = value ? getComputedStyle(value) : null;
      const form = trigger ? trigger.closest("form") : null;
      const fRect2 = form ? form.getBoundingClientRect() : null;
      const doc = document.scrollingElement;
      return {
        dlgOverflowX: dlg.scrollWidth - dlg.clientWidth,
        dlgOverflowY: dlg.scrollHeight - dlg.clientHeight,
        dlgWidth: Math.round(dlgRect.width),
        dlgLeft: Math.round(dlgRect.left * 10) / 10,
        dlgRight: Math.round(dlgRect.right * 10) / 10,
        inViewportX: dlgRect.left >= -0.5 && dlgRect.right <= window.innerWidth + 0.5,
        inViewportY: dlgRect.top >= -0.5 && dlgRect.bottom <= window.innerHeight + 0.5,
        pageOverflowX: doc ? doc.scrollWidth - doc.clientWidth : null,
        trackPx: track,
        contentBoxW: Math.round(contentBoxW * 10) / 10,
        title: title
          ? {
              singleLine:
                tRect.height <= parseFloat(tCS.lineHeight) * 1.45 + 1,
              lineH: tCS.lineHeight,
              rectH: Math.round(tRect.height * 10) / 10,
              textOverflow: tCS.textOverflow,
              whiteSpace: tCS.whiteSpace,
              overflowX: tCS.overflowX,
              truncated: title.scrollWidth > title.clientWidth + 1,
              scrollW: title.scrollWidth,
              clientW: title.clientWidth,
              attr: title.getAttribute("title"),
              rectLeft: Math.round(tRect.left * 10) / 10,
              rectRight: Math.round(tRect.right * 10) / 10,
              insideDlgX:
                tRect.left >= dlgRect.left - 0.5 &&
                tRect.right <= dlgRect.right + 0.5,
            }
          : null,
        hasDesc: !!desc,
        descInsideDlgX: desc
          ? desc.getBoundingClientRect().right <= dlgRect.right + 0.5
          : null,
        footerRect: fRect
          ? {
              inViewport: fRect.top >= -0.5 && fRect.bottom <= window.innerHeight + 0.5 && fRect.left >= -0.5 && fRect.right <= window.innerWidth + 0.5,
              width: Math.round(fRect.width),
            }
          : null,
        trigger: trigger
          ? {
              // 裁剪判定落在值内层文本 span（SelectValue 是 min-w-0 容器，
              // 内层 span.block.truncate 才承载 ellipsis）
              clipped: (() => {
                const inner = value.querySelector("span.block");
                return inner
                  ? inner.scrollWidth > inner.clientWidth + 1 &&
                      getComputedStyle(inner).overflowX !== "visible"
                  : value.scrollWidth > value.clientWidth + 1 &&
                      vCS.overflowX !== "visible";
              })(),
              ellipsis:
                (vCS.webkitLineClamp || "").includes("1") ||
                vCS.textOverflow === "ellipsis",
              withinForm:
                tRect2.right <= fRect2.right + 1 && tRect2.left >= fRect2.left - 1,
            }
          : null,
      };
    },
    { kind, withSelect: !!opts.withSelect }
  );
  Object.assign(m, d);

  if (d.missing) {
    fails.push({ case: m.label, what: "dialog missing" });
    return d;
  }
  // —— 断言 ——
  assert(m, d.dlgOverflowX === 0, "对话框内部水平溢出(scrollWidth-clientWidth)");
  assert(m, d.pageOverflowX === 0, "页面级水平溢出");
  assert(m, d.inViewportX === true, "对话框未越出视口(横向)");
  assert(m, d.inViewportY === true, "对话框未越出视口(纵向)");
  if (d.trackPx?.length === 1) {
    assert(
      m,
      d.trackPx[0] <= d.contentBoxW + 0.5,
      `grid 轨道宽 ${d.trackPx[0]} 超过内容盒 ${d.contentBoxW}`
    );
  }
  if (d.title) {
    assert(m, d.title.singleLine === true, "标题未单行(高度超一行)");
    assert(m, d.title.textOverflow === "ellipsis", "标题 textOverflow != ellipsis");
    assert(m, d.title.overflowX === "hidden", "标题 overflowX != hidden");
    if (opts.expectTruncate) {
      assert(m, d.title.truncated === true, "长标题未被截断(scrollWidth<=clientWidth)");
    }
    assert(
      m,
      d.title.attr === opts.expectTitle,
      `title 属性与完整标题不符: ${JSON.stringify(d.title.attr)}`
    );
    assert(m, d.title.insideDlgX === true, "标题渲染越出对话框边界(穿模)");
    assert(m, d.hasDesc === true, "缺少描述元素");
    assert(m, d.descInsideDlgX === true, "描述越出对话框");
  } else {
    fails.push({ case: m.label, what: "title element missing" });
  }
  if (d.footerRect) assert(m, d.footerRect.inViewport === true, "页脚按钮越出视口");
  if (opts.withSelect && d.trigger) {
    assert(m, d.trigger.clipped === true, "select 值未被裁剪截断");
    assert(m, d.trigger.ellipsis === true, "select 值无省略号");
    assert(m, d.trigger.withinForm === true, "select 触发器越出表单列");
  }
  return d;
}

async function measureDropdown(page, m) {
  const d = await page.evaluate(() => {
    const lb = document.querySelector('[role="listbox"]');
    const content = lb ? lb.closest('[data-slot="select-content"]') ?? lb : null;
    if (!content) return { missing: true };
    const r = content.getBoundingClientRect();
    const cs = getComputedStyle(content);
    const doc = document.scrollingElement;
    const items = [...content.querySelectorAll('[role="option"]')].map((o) => {
      // 标题 span：带内联 padding-left（树缩进）的那个；无则退回 option 本体
      const span =
        [...o.querySelectorAll("span")].find((s) =>
          /padding-left/.test(s.getAttribute("style") || "")
        ) ?? o;
      const sr = span.getBoundingClientRect();
      return {
        text: (o.textContent || "").trim().slice(0, 14),
        indentPx: parseFloat(getComputedStyle(span).paddingLeft) || 0,
        left: Math.round((sr.left - r.left) * 10) / 10,
        overflow: span.scrollWidth > span.clientWidth + 1,
        selected:
          o.getAttribute("data-state") === "checked" ||
          o.hasAttribute("data-selected"),
      };
    });
    // 缩进步长
    const steps = [];
    for (let i = 1; i < items.length; i++) {
      steps.push(
        Math.round((items[i].indentPx - items[i - 1].indentPx) * 10) / 10
      );
    }
    return {
      listboxOverflowX: content.scrollWidth - content.clientWidth,
      listboxLeft: Math.round(r.left * 10) / 10,
      listboxRight: Math.round(r.right * 10) / 10,
      inViewport: r.left >= -1 && r.right <= window.innerWidth + 1,
      maxWidth: cs.maxWidth,
      itemOverflow: items.some((i) => i.overflow),
      items,
      indentSteps: steps,
      pageOverflowX: doc ? doc.scrollWidth - doc.clientWidth : null,
    };
  });
  Object.assign(m, d);
  if (d.missing) {
    fails.push({ case: m.label, what: "dropdown missing" });
    return d;
  }
  assert(m, d.listboxOverflowX === 0, "下拉面板内部水平溢出");
  assert(m, d.inViewport === true, "下拉面板越出视口");
  assert(m, d.itemOverflow === false, "下拉选项文本横向溢出");
  assert(m, d.pageOverflowX === 0, "下拉打开时页面级水平溢出");
  // 缩进：全部相邻步长一致且 > 0（同层父子树），或单调（0 起）
  const steps = d.indentSteps.filter((s) => s > 0);
  if (steps.length) {
    const uniq = [...new Set(steps.map((s) => Math.round(s)))];
    assert(
      m,
      uniq.length === 1,
      `缩进步长不一致: ${JSON.stringify(d.indentSteps)}`
    );
  }
  return d;
}

async function openMoveDialog(page) {
  await page.click('button[aria-label="更多"]');
  await page.waitForTimeout(250);
  await page.click('div[role="menu"] >> text=移动');
  await page.waitForSelector('[data-slot="dialog-content"]', { timeout: 5000 });
  await page.waitForTimeout(350);
}

async function openDeleteDialog(page) {
  await page.click('button[aria-label="更多"]');
  await page.waitForTimeout(250);
  await page.click('div[role="menu"] >> text=删除');
  await page.waitForSelector('[data-slot="alert-dialog-content"]', {
    timeout: 5000,
  });
  await page.waitForTimeout(350);
}

async function closeDialogs(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
}

async function runCombo(style, mode, width, height, pageId, tag) {
  await setTheme(style);
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  await context.addCookies([
    { name: "ciki_session", value: sess, domain: "localhost", path: "/" },
  ]);
  await context.addInitScript(
    ([v]) => {
      window.localStorage.setItem("ciki-theme", v);
    },
    [JSON.stringify({ state: { mode, style, migratedAt: null, modeMigratedAt: null }, version: 0 })]
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/p/${pageId}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("button[aria-label=\"更多\"]", { timeout: 30000 });
  await page.waitForTimeout(600);

  const themeAttr = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    dark: document.documentElement.classList.contains("dark"),
    mode: document.documentElement.getAttribute("data-mode"),
  }));
  if (themeAttr.theme !== style || themeAttr.dark !== (mode === "dark")) {
    fails.push({ case: tag, what: "theme mismatch", got: JSON.stringify(themeAttr) });
  }

  const label = `${tag}-${style}-${mode}-${width}`;

  if (pageId === 5) {
    // 场景 A：移动对话框（长标题被移动页自身）
    await openMoveDialog(page);
    const mA = { label: `${label}-move-closed` };
    await page.screenshot({ path: `${SHOTS}/${label}-move-closed.png` });
    await measureDialog(page, mA, {
      kind: "dialog",
      expectTitle: EXPECT_MOVE_E,
      expectTruncate: true,
      withSelect: true,
    });
    results.push(mA);

    // 悬停：光标移到标题上（原生 title 浮层为浏览器级行为，headless 不渲染截图；
    // 以 title 属性 + 悬停不改变布局为证）
    const titleBox = await page
      .locator('[data-slot="dialog-title"]')
      .boundingBox();
    if (titleBox) {
      await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/${label}-move-title-hover.png` });
    }

    // 下拉展开（#279 回归 + 长标题选项截断）
    await page.click("#move-page-parent");
    await page.waitForSelector('[role="listbox"]', { timeout: 5000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/${label}-move-open.png` });
    const mA2 = { label: `${label}-move-open` };
    await measureDropdown(page, mA2);
    results.push(mA2);
    await closeDialogs(page);

    // 场景 B：PageView 删除对话框（同族长标题）
    await openDeleteDialog(page);
    const mB = { label: `${label}-delete-closed` };
    await page.screenshot({ path: `${SHOTS}/${label}-delete-closed.png` });
    await measureDialog(page, mB, {
      kind: "alert-dialog",
      expectTitle: EXPECT_DEL_E,
      expectTruncate: true,
      withSelect: false,
    });
    results.push(mB);
    await closeDialogs(page);
  } else {
    // 场景 C：#279 回归（短标题页 /p/6，深层级）
    await openMoveDialog(page);
    const mC = { label: `${label}-move-closed` };
    await page.screenshot({ path: `${SHOTS}/${label}-move-closed.png` });
    await measureDialog(page, mC, {
      kind: "dialog",
      expectTitle: EXPECT_MOVE_F,
      expectTruncate: false, // 短标题不应触发截断（truncated 允许 false）
      withSelect: true,
    });
    // 短标题：truncated 应为 false（不被误伤）——单列检查
    if (mC.title && mC.title.truncated === true) {
      fails.push({ case: mC.label, what: "短标题被误截断" });
    }
    results.push(mC);

    await page.click("#move-page-parent");
    await page.waitForSelector('[role="listbox"]', { timeout: 5000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/${label}-move-open.png` });
    const mC2 = { label: `${label}-move-open` };
    await measureDropdown(page, mC2);
    results.push(mC2);
    await closeDialogs(page);
  }

  if (errors.length) fails.push({ case: tag, what: "pageerror", got: errors });

  await browser.close();
}

// ===== 主矩阵 =====
// 场景 A+B：/p/5（长标题被移动页） nova/paper × light/dark × 1280/500 = 8 组合
const combos = [];
for (const style of ["nova", "paper"])
  for (const mode of ["light", "dark"])
    for (const [w, h] of [[1280, 800], [500, 800]])
      combos.push([style, mode, w, h, 5]);

// 场景 C：/p/6 短标题回归（nova-light-1280 + paper-dark-500 覆盖两端）
combos.push(["nova", "light", 1280, 800, 6]);
combos.push(["paper", "dark", 500, 800, 6]);

for (const [style, mode, w, h, pid] of combos) {
  await runCombo(style, mode, w, h, pid, pid === 5 ? "long" : "short");
}

fs.writeFileSync(DIR + "/results.json", JSON.stringify(results, null, 2));
fs.writeFileSync(DIR + "/fails.json", JSON.stringify(fails, null, 2));
console.log(`DONE ${results.length} measurements, ${fails.length} failures`);
if (fails.length) console.log(JSON.stringify(fails, null, 2));
