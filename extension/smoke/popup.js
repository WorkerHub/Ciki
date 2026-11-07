// ciki 冒烟验证 · popup 逻辑
// 流程：探测当前页 pageId -> 申请该域名权限 -> 带登录态（当前浏览器会话 cookie）
// 只读 GET 调用 Confluence REST -> 只回报状态码 / 字节数 / 张数，绝不展示正文内容。

var IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function $(id) { return document.getElementById(id); }
function setStatus(text) { $("status").textContent = text; }
function addRow(name, detail, cls) {
  var li = document.createElement("li");
  if (cls) li.className = cls;
  var b = document.createElement("b");
  b.textContent = name + "：";
  li.appendChild(b);
  li.appendChild(document.createTextNode(detail));
  $("results").appendChild(li);
}
function friendlyError(e) {
  var msg = (e && e.message) || String(e);
  if (/Failed to fetch/i.test(msg)) {
    return "网络层失败（域名不可达 / 权限未授予 / 被 SSO 拦截跳转）。";
  }
  return msg;
}

// 带超时地取 JSON：手动 follow 重定向以便识别「被带去登录页」。
async function fetchJson(url, timeoutMs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 20000);
  try {
    var res = await fetch(url, {
      credentials: "include",
      redirect: "manual",
      signal: ctrl.signal,
      headers: { "Accept": "application/json" }
    });
    var out = { status: res.status, type: res.type, redirectedToLogin: false, json: null, textBytes: 0 };
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      out.redirectedToLogin = true;
      return out;
    }
    var text = await res.text();
    out.textBytes = text.length;
    if (res.ok) {
      try { out.json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// 带超时地下二进制（附件原图），只取 blob 大小，不做任何展示。
async function fetchBlobInfo(url, timeoutMs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000);
  try {
    var res = await fetch(url, { credentials: "include", redirect: "manual", signal: ctrl.signal });
    var out = { status: res.status, type: res.type, redirectedToLogin: false, size: 0, contentType: "" };
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      out.redirectedToLogin = true;
      return out;
    }
    out.contentType = res.headers.get("content-type") || "";
    if (res.ok) {
      var blob = await res.blob();
      out.size = blob.size;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function buildBases(origin, contextPath) {
  var cp = contextPath || "";
  var bases = [];
  if (cp) bases.push(origin + cp);
  bases.push(origin);
  if (origin.indexOf(".atlassian.net") !== -1) bases.push(origin + "/wiki");
  return bases.filter(function (v, i, a) { return a.indexOf(v) === i; });
}

async function runSmoke() {
  $("results").innerHTML = "";
  $("run").disabled = true;
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs && tabs[0];
    if (!tab || !tab.id || !/^https?:/i.test(tab.url || "")) {
      setStatus("当前标签页不是 http(s) 页面，请先打开一篇 Confluence 资料页再点验证。");
      return;
    }
    var tabUrl = new URL(tab.url);
    var origin = tabUrl.origin;

    setStatus("正在探测当前页 pageId…");
    // 以函数注入方式执行探测（与 content-probe.js 同一份逻辑的可注入版）。
    // 不用 files 注入：普通脚本注入无法保证拿到返回值，函数注入直接返回结果。
    var injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        var pageId = null, idSource = "none";
        var meta = document.querySelector('meta[name="ajs-page-id"]');
        if (meta && meta.content) { pageId = meta.content; idSource = "meta ajs-page-id"; }
        if (!pageId && window.AJS && AJS.params && AJS.params.pageId) { pageId = String(AJS.params.pageId); idSource = "AJS.params.pageId"; }
        if (!pageId) { var m = /[?&]pageId=(\d+)/.exec(location.search); if (m) { pageId = m[1]; idSource = "URL pageId 参数"; } }
        if (!pageId) { var m2 = /\/pages\/(\d+)/.exec(location.pathname); if (m2) { pageId = m2[1]; idSource = "URL /pages/{id}"; } }
        var ctxMeta = document.querySelector('meta[name="ajs-context-path"]');
        var contextPath = ctxMeta ? (ctxMeta.content || "") : "";
        if (window.AJS && AJS.params && typeof AJS.params.contextPath === "string") contextPath = AJS.params.contextPath;
        if (contextPath && contextPath.charAt(contextPath.length - 1) === "/") contextPath = contextPath.slice(0, -1);
        return { pageId: pageId, idSource: idSource, contextPath: contextPath };
      }
    });
    var probe = injected && injected[0] && injected[0].result;

    var contextPath = probe && probe.contextPath ? probe.contextPath : "";
    var pageId = probe && probe.pageId ? String(probe.pageId) : null;

    addRow("站点", origin + (contextPath ? "（contextPath " + contextPath + "）" : ""));
    addRow("pageId", pageId ? pageId + "（来源：" + (probe.idSource || "?") + "）" : "未探测到 —— 当前页可能不是 Confluence 内容页", pageId ? "" : "bad");

    setStatus("正在申请该域名权限…");
    var permOrigin = tabUrl.protocol + "//" + tabUrl.host + "/*";
    var granted = await chrome.permissions.request({ origins: [permOrigin] });
    addRow("域名权限", granted ? "已授予 " + permOrigin : "未授予（请在弹窗点允许）", granted ? "ok" : "bad");
    if (!granted) { setStatus("权限未授予，验证中止。点「开始验证」重试并允许授权。"); return; }

    var bases = buildBases(origin, contextPath);
    var workingBase = null;
    var contentJson = null;

    if (pageId) {
      setStatus("正在调用 REST 取 storage 正文…");
      for (var i = 0; i < bases.length; i++) {
        var base = bases[i];
        var apiUrl = base + "/rest/api/content/" + encodeURIComponent(pageId) + "?expand=body.storage,version";
        try {
          var r1 = await fetchJson(apiUrl);
          if (r1.redirectedToLogin) {
            addRow("REST 取正文 @ " + base, "HTTP " + r1.status + "，被重定向到登录态之外 —— 会话可能已过期或接口被 SSO 拦截", "bad");
            continue;
          }
          addRow("REST 取正文 @ " + base, "HTTP " + r1.status + (r1.json ? "，响应 " + r1.textBytes + " 字节" : "，响应非 JSON（" + r1.textBytes + " 字节）"), r1.status === 200 ? "ok" : "bad");
          if (r1.status === 200 && r1.json) { workingBase = base; contentJson = r1.json; break; }
        } catch (e) {
          addRow("REST 取正文 @ " + base, "请求异常：" + friendlyError(e), "bad");
        }
      }
      if (contentJson) {
        var storage = contentJson.body && contentJson.body.storage && contentJson.body.storage.value;
        var title = contentJson.title || "";
        addRow("页面标题", title ? title : "(空)", "");
        addRow("storage 正文", typeof storage === "string" ? storage.length + " 字符 —— storage 格式可取 ✔" : "响应里没有 body.storage（可能该版本字段名不同）", typeof storage === "string" ? "ok" : "bad");
      } else {
        addRow("结论", "没拿到正文 JSON。若上面是 401/403，多半是登录态或接口权限问题；404 可能是 contextPath 不对。", "bad");
      }
    }

    if (workingBase && pageId) {
      setStatus("正在取附件清单…");
      try {
        var attUrl = workingBase + "/rest/api/content/" + encodeURIComponent(pageId) + "/child/attachment?limit=200";
        var r2 = await fetchJson(attUrl);
        if (r2.redirectedToLogin) {
          addRow("附件清单", "被重定向 —— 登录态异常", "bad");
        } else if (r2.status === 200 && r2.json && Array.isArray(r2.json.results)) {
          var results = r2.json.results;
          var images = results.filter(function (a) {
            var mediaType = (a.metadata && a.metadata.mediaType) || "";
            var name = a.title || "";
            return mediaType.indexOf("image/") === 0 || IMAGE_EXT.test(name);
          });
          addRow("附件清单", "共 " + results.length + " 个附件，其中图片 " + images.length + " 张", "ok");
          if (images.length > 0) {
            var first = images[0];
            var dl = first._links && first._links.download;
            if (dl) {
              var dlUrl = dl.charAt(0) === "/" ? workingBase + dl : dl;
              setStatus("正在下载第一张图片原图（只验大小）…");
              var r3 = await fetchBlobInfo(dlUrl);
              if (r3.redirectedToLogin) {
                addRow("首图下载", "被重定向 —— 附件下载需要重新登录", "bad");
              } else {
                addRow("首图下载", "HTTP " + r3.status + "，类型 " + (r3.contentType || "?") + "，大小 " + r3.size + " 字节" + (r3.size > 0 ? " —— 原图可下 ✔" : ""), r3.status === 200 && r3.size > 0 ? "ok" : "bad");
              }
            } else {
              addRow("首图下载", "附件条目里没有 download 链接，跳过", "bad");
            }
          }
        } else {
          addRow("附件清单", "HTTP " + r2.status + (r2.redirectedToLogin ? "（重定向）" : ""), "bad");
        }
      } catch (e) {
        addRow("附件清单", "请求异常：" + friendlyError(e), "bad");
      }
    }

    setStatus("验证完成。把上面这几行结果发回给 Muse 即可（只有状态与字节数，没有正文内容）。");
  } catch (e) {
    setStatus("出错：" + friendlyError(e));
  } finally {
    $("run").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", function () {
  $("run").addEventListener("click", runSmoke);
});
