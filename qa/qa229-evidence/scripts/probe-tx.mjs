// QA229 事务探针：钩住 dom.editor 的全部事件，抓「落定后无交互 bump」的事务
// 证据只落盘 /tmp/ciki-qa229，不入库。口令/cookie 走文件，不进日志。
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { launchOptions } from './lib.mjs'

const base = process.argv[2] || 'http://127.0.0.1:9221'
const pageId = process.env.QA_PAGE_ID || '1'
const reloads = Number(process.env.QA_RELOADS || 10)
const cookieFile = process.env.QA_COOKIE_FILE || '/tmp/ciki-qa229/qa229.cookies'

const cookies = readFileSync(cookieFile, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    if (l.startsWith('#HttpOnly_')) l = l.slice('#HttpOnly_'.length)
    else if (l.startsWith('#')) return null
    const p = l.split('\t')
    if (p.length < 7) return null
    return { name: p[5], value: p[6], domain: p[0], path: p[2] }
  })
  .filter(Boolean)

const browser = await chromium.launch(launchOptions())
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addCookies(cookies)

const INIT = `
window.__txlog = []
;(() => {
  const t0 = performance.now()
  const log = (ev, d) => window.__txlog.push({ t: Math.round(performance.now() - t0), ev, ...d })
  // fetch 完成顺序（页面 vs 空间列表谁先回来）
  const of = window.fetch
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''
    const start = performance.now()
    try {
      const res = await of(...args)
      if (url.includes('/api/pages') || url.includes('/api/spaces')) {
        let path = url
        try { const u = new URL(url, location.href); path = u.pathname + u.search } catch {}
        log('fetch-done', { url: path, ms: Math.round(performance.now() - start) })
      }
      return res
    } catch (e) { throw e }
  }
  const edInfo = () => {
    const dom = document.querySelector('.ProseMirror')
    if (!dom || !dom.editor) return null
    const ed = dom.editor
    return { instanceId: ed.instanceId, docFirst: ed.state.doc.firstChild && ed.state.doc.firstChild.type.name,
             selParent: (() => { try { return ed.state.selection.$from.parent.type.name } catch { return null } })() }
  }
  const selInfo = (ed) => {
    try {
      const s = ed.state.selection
      const $f = s.$from
      return { from: s.from, to: s.to, parent: $f.parent.type.name, depth: $f.depth,
               idx0: $f.index(0), docFirst: ed.state.doc.firstChild && ed.state.doc.firstChild.type.name }
    } catch { return null }
  }
  const trInfo = (tr) => {
    if (!tr) return null
    let metas = []
    try { metas = Object.keys(tr.meta || {}) } catch {}
    return { docChanged: tr.docChanged, selectionSet: tr.selectionSet, steps: tr.steps.length, metas,
             isBlank: !tr.docChanged && !tr.selectionSet && tr.steps.length === 0 }
  }
  const attach = (ed) => {
    if (ed.__qa_hooked) return false
    ed.__qa_hooked = true
    log('attach', { instanceId: ed.instanceId, editable: ed.isEditable, sel: selInfo(ed) })
    for (const ev of ['beforeCreate','create','mount','transaction','update','selectionUpdate','focus','blur']) {
      ed.on(ev, (p) => {
        const entry = { instanceId: ed.instanceId }
        const tr = p && p.transaction
        const info = trInfo(tr)
        if (info) entry.tr = info
        if (tr) entry.stack = (new Error().stack || '').split('\\n').slice(2, 8).join(' | ')
        if (ev === 'selectionUpdate' || ev === 'focus') entry.sel = selInfo(ed)
        log(ev, entry)
      })
    }
    return true
  }
  setInterval(() => {
    const dom = document.querySelector('.ProseMirror')
    if (dom && dom.editor) attach(dom.editor)
  }, 4)
  // 标签文本变化（事件驱动，覆盖 rAF 采样之间的窗口）
  let lastLabel = null
  const readLabel = () => {
    const trg = document.querySelector('[aria-label="段落样式"]')
    if (!trg) return null
    const v = trg.querySelector('[data-slot]')
    return v ? v.textContent : null
  }
  const mo = new MutationObserver(() => {
    const cur = readLabel()
    if (cur !== null && cur !== lastLabel) {
      lastLabel = cur
      log('label', { value: cur, ed: edInfo() })
    }
  })
  const startMo = () => mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  if (document.body) startMo()
  else document.addEventListener('DOMContentLoaded', startMo, { once: true })
  setInterval(() => {
    const cur = readLabel()
    if (cur !== null && cur !== lastLabel) { lastLabel = cur; log('label', { value: cur, via: 'poll' }) }
  }, 8)
})()
`

mkdirSync('/tmp/ciki-qa229', { recursive: true })
const runs = []
for (let i = 1; i <= reloads; i++) {
  const page = await ctx.newPage()
  await page.addInitScript(INIT)
  const url = `${base}/p/${pageId}/edit?qa=${Date.now()}-${i}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="段落样式"]', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(3500)
  const txlog = await page.evaluate(() => window.__txlog || [])
  const finalLabel = await page.evaluate(() => {
    const trg = document.querySelector('[aria-label="段落样式"]')
    const v = trg && trg.querySelector('[data-slot]')
    return v ? v.textContent : null
  })
  const active = await page.evaluate(() => document.activeElement && document.activeElement.className)
  const hit = txlog.some((e) => e.ev === 'label' && e.value && e.value !== '正文')
  runs.push({ run: i, finalLabel, active, hit, txlog })
  await page.close()
  console.log(`run ${i}: label=${finalLabel} hit=${hit ? 'HIT' : 'pass'} events=${txlog.length}`)
}
await browser.close()
writeFileSync('/tmp/ciki-qa229/capture-tx.json', JSON.stringify({ capturedAt: new Date().toISOString(), base, pageId, reloads, runs }, null, 2))
console.log('saved /tmp/ciki-qa229/capture-tx.json')
