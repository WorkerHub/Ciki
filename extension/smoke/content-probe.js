// 参考副本：与 popup.js 内以函数注入执行的探测逻辑完全一致。
// 冒烟流程用 chrome.scripting.executeScript({ func }) 直接注入并取返回值，
// 这个文件不被 manifest 引用，仅供阅读与将来正式插件复用。
function cikiSmokeProbe() {
  var pageId = null;
  var idSource = "none";

  var meta = document.querySelector('meta[name="ajs-page-id"]');
  if (meta && meta.content) {
    pageId = meta.content;
    idSource = "meta ajs-page-id";
  }
  if (!pageId && window.AJS && AJS.params && AJS.params.pageId) {
    pageId = String(AJS.params.pageId);
    idSource = "AJS.params.pageId";
  }
  if (!pageId) {
    var m = /[?&]pageId=(\d+)/.exec(location.search);
    if (m) {
      pageId = m[1];
      idSource = "URL pageId 参数";
    }
  }
  if (!pageId) {
    var m2 = /\/pages\/(\d+)/.exec(location.pathname);
    if (m2) {
      pageId = m2[1];
      idSource = "URL /pages/{id}";
    }
  }

  var ctxMeta = document.querySelector('meta[name="ajs-context-path"]');
  var contextPath = ctxMeta ? ctxMeta.content || "" : "";
  if (window.AJS && AJS.params && typeof AJS.params.contextPath === "string") {
    contextPath = AJS.params.contextPath;
  }
  if (contextPath && contextPath.charAt(contextPath.length - 1) === "/") {
    contextPath = contextPath.slice(0, -1);
  }

  return { pageId: pageId, idSource: idSource, contextPath: contextPath };
}
