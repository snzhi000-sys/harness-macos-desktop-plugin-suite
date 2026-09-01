const STARTUP_MESSAGE = '正在启动 DeepSeek Harness，首次启动可能需要几秒钟'

/** Returns the local three-region placeholder shown while the Web backend starts. */
export function startupDocument() {
  const markup = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{color-scheme:light;--bg:#f6f7f8;--chrome:#fafafa;--panel:#e8eaed;--panel-alt:#eceef0;--border:#e1e3e6;--shine:#f4f5f6;--muted:#7c818b}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#17181a;--chrome:#1b1c1f;--panel:#25272b;--panel-alt:#292b30;--border:#2c2e33;--shine:#34373d;--muted:#9298a3}}
*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}body{font:13px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;background:var(--bg);color:var(--muted);opacity:1;transition:opacity 180ms ease}
html[data-leaving="true"] body{opacity:0}.app{height:100%;display:grid;grid-template-rows:32px minmax(0,1fr) 34px;background:var(--bg)}
.titlebar{border-bottom:1px solid var(--border);background:var(--chrome)}
.columns{min-height:0;display:grid;grid-template-columns:minmax(190px,15%) minmax(230px,18%) minmax(0,1fr);gap:10px;padding:10px}
.panel{min-width:0;position:relative;overflow:hidden;border:1px solid var(--border);border-radius:10px;background:var(--panel)}
.explorer{background:var(--panel-alt)}.chat{background:var(--panel)}
.panel::after{content:"";position:absolute;inset:0;transform:translateX(-110%);background:linear-gradient(90deg,transparent 0%,var(--shine) 50%,transparent 100%);opacity:.6;animation:shimmer 2s ease-in-out infinite}
.startup-message{margin:0;text-align:center;font-size:11px;line-height:24px;letter-spacing:.01em;color:var(--muted);white-space:nowrap}
@keyframes shimmer{to{transform:translateX(110%)}}@media(prefers-reduced-motion:reduce){.panel::after{animation:none}body{transition:none}}@media(max-width:980px){.columns{grid-template-columns:190px 220px minmax(0,1fr)}}
</style></head><body><main class="app" aria-label="DeepSeek Harness 正在启动">
<header class="titlebar" aria-hidden="true"></header>
<div class="columns" aria-hidden="true"><section class="panel sessions"></section><section class="panel explorer"></section><section class="panel chat"></section></div>
<p class="startup-message" role="status" aria-live="polite">${STARTUP_MESSAGE}</p>
</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`
}

/** Fades the startup document before the BrowserWindow navigates to Harness. */
export async function fadeStartupDocument(webContents) {
  try {
    await webContents.executeJavaScript(`document.documentElement.dataset.leaving = 'true'; new Promise(resolve => setTimeout(resolve, 180))`)
  } catch {
    // Navigation or window teardown can supersede the cosmetic fade.
  }
}
