import { ui } from '../ui-language.js';

/** No credential values are embedded here; tokenEnv is a validated variable name. */
export function loginPage(failed: boolean, tokenEnv: string) {
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv) ? tokenEnv : 'WEBUI_TOKEN';
  return `<!doctype html>
<html lang="${ui('en', 'zh')}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${ui('Sign in · Qiuyue', '登录 · 秋月管理')}</title>
  <link rel="icon" type="image/svg+xml" href="/app/favicon.svg">
  <link rel="stylesheet" href="/app/style.css">
  <script type="module" src="/app/login.js"></script>
</head>
<body class="login-page">
  <header class="login-header">
    <div class="login-brand"><span class="login-brand-mark" aria-hidden="true">☾</span><div>${ui('Qiuyue', '秋月')}<small>DIGITAL LIFE</small></div></div>
    <span class="login-header-label">${ui('Management', '管理入口')}</span>
  </header>
  <main class="login-main">
    <div class="login-layout">
      <section class="login-scene" aria-labelledby="login-scene-title">
        <div class="eyebrow">A SPACE FOR EVERYDAY LIFE</div>
        <div class="login-illustration" aria-hidden="true"><div class="login-orbit"></div><div class="login-orbit inner"></div><div class="login-moon"></div><span class="login-star star-one">✦</span><span class="login-star star-two">✧</span><i class="login-satellite"></i></div>
        <div class="login-scene-copy"><h2 id="login-scene-title">${ui('A familiar place.<br>A continuing life.', '与秋月的日常，<br>从这里继续。')}</h2>
          <p>${ui('Follow her days, shape her world,<br>and make room for what comes next.', '看看她的近况，调整生活的细节，<br>也为新的故事留一点空间。')}</p>
        </div>
        <div class="login-scene-foot">${ui('Activity · Configuration · Persona · Models', '状态 · 配置 · 人格 · 模型')}</div>
      </section>
      <section class="login-panel" aria-labelledby="login-title">
        <div class="eyebrow">WELCOME BACK</div>
        <h1 id="login-title">${ui('Sign in to Qiuyue', '登录管理台')}</h1>
        <p class="login-intro">${ui('Enter your access token to continue.', '使用访问令牌，进入秋月的管理空间。')}</p>
        <form action="/login" method="post" class="login-form">
          <label for="login-token">${ui('Access token', '访问令牌')}</label>
          <div class="login-token-wrap"><input id="login-token" name="token" type="password" autocomplete="current-password" required maxlength="4096" spellcheck="false" autocapitalize="none" placeholder="${ui('Paste your access token', '粘贴你的访问令牌')}" aria-invalid="${failed}" aria-describedby="login-token-hint${failed ? ' login-error' : ''}">
            <button id="login-reveal" class="login-reveal" type="button" aria-controls="login-token" aria-pressed="false" data-show="${ui('Show', '显示')}" data-hide="${ui('Hide', '隐藏')}" hidden>${ui('Show', '显示')}</button>
          </div>
          <p id="login-token-hint" class="login-hint">${ui(`Enter the value of ${name} from your credential file or deployment environment.`, `填写凭据文件或部署环境中的 ${name} 值。`)}</p>
          ${failed ? `<p id="login-error" class="login-error" role="alert">${ui('That token was not accepted. Copy its value again; the variable name itself is not a token.', '令牌不正确。请重新复制凭据的值，不要填写凭据名称。')}</p>` : ''}
          <button class="primary login-submit" type="submit">${ui('Open management', '进入管理台')}<span aria-hidden="true">↗</span></button>
        </form>
        <details class="login-help"${failed ? ' open' : ''}>
          <summary>${ui('Where do I find my token?', '访问令牌在哪里？')}<span aria-hidden="true">＋</span></summary>
          <div class="login-help-content"><p>${ui(`Open the file named by <code>credentialsFile</code> in <code>config.json</code> (defaults to <code>credentials.json</code>). Find <code>${name}</code> under <code>credentials</code> and copy its value, without surrounding quotes. An externally supplied environment variable takes precedence.`, `打开 <code>config.json</code> 中 <code>credentialsFile</code> 指向的文件（默认 <code>credentials.json</code>），在 <code>credentials</code> 中找到 <code>${name}</code> 并复制其值，不含两侧引号。外部环境变量优先。`)}</p>
          <p>${ui('If it is not set there, check the terminal or log used to start the management page. With no configured token, each start prints a temporary access token; copy the latest one into this form.', '如果文件里没有设置，请查看启动管理网页的终端或日志。未配置令牌时，每次启动都会打印临时访问令牌，复制最近一次的令牌填入此表单。')}</p></div>
        </details>
        <div class="login-note"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg><span>${ui('Your token stays on this management server.', '访问令牌仅发送给当前管理服务。')}</span></div>
      </section>
    </div>
  </main>
  <footer class="login-footer">QIUYUE <span aria-hidden="true">/</span> ${ui('A digital life, day by day.', '日常有续，故事未完。')}</footer>
</body></html>`;
}
