/**
 * 两份模拟 Confluence 剪贴板样本 —— 粘贴验证小样 v0.4 的原文，测试与联调自检以其为准。
 * 内容全部是虚构的示例数据，不含任何真实文档。
 */

// 形态二（2026-11-07 用户真实文档实测翻车后补）：从 Confluence 阅读页复制的
// SyntaxHighlighter 表格型代码块 —— 左列是行号 gutter，右列每个词一个 <code>。
export const SAMPLE_SH_TABLE_HTML = `
<div class="syntaxhighlighter nogutter sql" id="highlighter_123">
<table border="0" cellpadding="0" cellspacing="0">
<tbody><tr>
<td class="gutter"><div class="line number1 index0 alt2">1</div><div class="line number2 index1 alt1">2</div><div class="line number3 index2 alt2">3</div></td>
<td class="code"><div class="container">
<div class="line number1 index0 alt2"><code class="sql keyword">with</code> <code class="sql plain">user_login_table</code> <code class="sql keyword">as</code> <code class="sql plain">(</code> <code class="sql keyword">select</code> <code class="sql plain">1001</code> <code class="sql keyword">as</code> <code class="sql plain">user_id</code></div>
<div class="line number2 index1 alt1"><code class="sql keyword">select</code> <code class="sql plain">user_id, count(1)</code></div>
<div class="line number3 index2 alt2"><code class="sql keyword">group</code> <code class="sql keyword">by</code> <code class="sql plain">user_id</code></div>
</div></td>
</tr></tbody>
</table>
</div>
<p>代码块后面的正文。</p>`

// 模拟 Confluence Server 复制出来的剪贴板 HTML（按真实结构仿制：
// confluenceTable 类名、syntaxhighlighter 代码宏、information 面板宏、inline-task-list、附件图片）
export const SAMPLE_CONFLUENCE_HTML = `
<style>.confluenceTable{border-collapse:collapse}.syntaxhighlighter-pre{font-family:monospace}</style>
<div class="wiki-content">
<h1 id="title-text"><span>支付服务部署手册</span></h1>
<p>本文说明 <strong>支付服务</strong> 的部署步骤，含 <em>注意事项</em>、行内代码 <code>payment start</code>、<s>旧流程</s> 与 <a class="external-link" href="https://example.com/runbook" rel="nofollow">外部 Runbook</a>，<span style="color:#de350b">红色警告文字</span>。</p>
<h2 id="a1"><span>1. 环境准备</span></h2>
<h3 id="a2"><span>1.1 依赖清单</span></h3>
<h4 id="a3"><span>1.1.1 运行时版本</span></h4>
<p>Java 17、MySQL 8.0，配置项见下表。</p>
<div class="code panel pdl conf-macro output-block" data-hasbody="true">
<div class="codeHeader panelHeader pdl"><b>PaymentApplication.java</b></div>
<div class="codeContent panelContent pdl">
<pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; gutter: false; theme: Confluence" data-theme="Confluence"><span class="token keyword">public</span> <span>class</span> <span>PaymentApplication</span> <span>{</span>
    <span class="token keyword">public</span> <span class="token keyword">static</span> <span>void</span> <span>main</span><span>(</span><span>String</span><span>[]</span> <span>args</span><span>)</span> <span>{</span>
        <span>System</span><span>.</span><span>out</span><span>.</span><span>println</span><span>(</span><span class="token string">"starting payment service"</span><span>);</span>
    <span>}</span>
<span>}</span></pre>
</div>
</div>
<p>初始化 SQL：</p>
<pre><code class="language-sql">CREATE TABLE payment_order (
  id BIGINT PRIMARY KEY,
  amount DECIMAL(12,2) NOT NULL
);</code></pre>
<h2 id="b1"><span>2. 配置表</span></h2>
<div class="table-wrap">
<table class="confluenceTable wrapped">
<colgroup><col style="width: 40%;"><col style="width: 20%;"><col style="width: 20%;"><col style="width: 20%;"></colgroup>
<colgroup><col style="width:120px"><col style="width:200px"><col style="width:200px"></colgroup>
<tbody>
<tr><th class="confluenceTh" colspan="3">2026 年度配置总览</th></tr>
<tr><th class="confluenceTh">环境</th><th class="confluenceTh">配置项</th><th class="confluenceTh">值</th></tr>
<tr><td class="confluenceTd" rowspan="2">生产</td><td class="confluenceTd">超时时间</td><td class="confluenceTd"><code>3000ms</code></td></tr>
<tr><td class="confluenceTd">重试策略</td><td class="confluenceTd"><ul><li>最多重试 3 次</li><li>间隔 500ms</li></ul></td></tr>
<tr><td class="confluenceTd">预发</td><td class="confluenceTd">超时时间</td><td class="confluenceTd"><code>5000ms</code></td></tr>
</tbody>
</table>
</div>
<h2 id="c1"><span>3. 操作步骤</span></h2>
<ul>
<li>第一步：拉取镜像
<ul>
<li>确认版本号
<ul><li>检查 <strong>tag</strong> 是否为最新</li></ul>
</li>
<li>记录镜像 ID</li>
</ul>
</li>
<li>第二步：启动服务</li>
</ul>
<ol><li>先启动网关</li><li>再启动支付服务</li></ol>
<ul class="inline-task-list" data-inline-tasks-content-id="page-1">
<li data-inline-task-id="1" class="checked" data-task-status="complete"><span>已完成数据库备份</span></li>
<li data-inline-task-id="2" data-task-status="incomplete"><span>待通知值班同学</span></li>
</ul>
<div class="confluence-information-macro confluence-information-macro-information conf-macro output-block">
<p class="title conf-macro-render">信息</p>
<div class="confluence-information-macro-body"><p>部署窗口为每周三 22:00–23:00。</p></div>
</div>
<div class="confluence-information-macro confluence-information-macro-warning conf-macro output-block">
<div class="confluence-information-macro-body"><p>生产部署必须双人复核。</p></div>
</div>
<blockquote><p>引用：回滚优先于排查。</p></blockquote>
<hr>
<p>架构图：</p>
<p><span class="confluence-embedded-file-wrapper"><img class="confluence-embedded-image" src="https://confluence.example.com/download/attachments/12345/arch.png" alt="架构图" width="640"></span></p>
</div>`
