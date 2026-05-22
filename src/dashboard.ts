/**
 * Squeezr Dashboard — single-file SPA
 * 2-page (Home + Settings), dark/light mode, SSE + polling fallback.
 * Zero external dependencies.
 */

export const DASHBOARD_HTML = /* html */`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Squeezr Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}

/* ── Theme tokens ── */
:root{
  --bg:#0a0a0a;--bg2:#0c0c0c;--bg3:#111111;--bg4:#141414;--bg5:#1a1a1a;
  --border:#262626;--border2:#404040;
  --text:#fafafa;--text2:#e5e5e5;--muted:#a3a3a3;
  --brand:#16a34a;--brand-hover:#15803d;--brand-light:#4ade80;
  --red:#ef4444;--yellow:#eab308;--blue:#60a5fa;
  --card-bg:#111111;--card-border:#262626;
  --input-bg:#141414;--input-border:#404040;
}
html:not(.dark){
  --bg:#ffffff;--bg2:#fafafa;--bg3:#f5f5f5;--bg4:#f0f0f0;--bg5:#e5e5e5;
  --border:#e5e5e5;--border2:#d4d4d4;
  --text:#0a0a0a;--text2:#171717;--muted:#737373;
  --card-bg:#ffffff;--card-border:#e5e5e5;
  --input-bg:#fafafa;--input-border:#d4d4d4;
}

html,body{
  height:100%;background:var(--bg);color:var(--text);
  font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
  font-size:14px;line-height:1.5;transition:background .15s,color .15s
}
a{color:var(--brand);text-decoration:none}
code,pre{font-family:'Cascadia Code','Fira Mono',Consolas,monospace}

/* ── App shell ── */
#app{display:flex;height:100vh;overflow:hidden}

/* ── Sidebar ── */
#sidebar{
  width:220px;flex-shrink:0;
  background:var(--bg2);border-right:1px solid var(--border);
  display:flex;flex-direction:column;overflow:hidden;
  transition:background .15s,border-color .15s
}

/* Brand area */
#sb-brand{
  padding:20px 16px 16px;
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:10px
}
#sb-brand .logo-svg{
  width:32px;height:32px;flex-shrink:0;color:var(--brand)
}
#sb-brand .brand-text .name{
  font-size:16px;font-weight:700;letter-spacing:-.2px;color:var(--text)
}
#sb-brand .brand-text .ver{
  font-size:11px;color:var(--muted);margin-top:1px
}

/* Nav */
nav{flex:1;padding:8px 8px;overflow-y:auto}
.nav-item{
  display:flex;align-items:center;gap:10px;
  padding:9px 10px;border-radius:8px;
  color:var(--muted);cursor:pointer;
  transition:background .1s,color .1s;user-select:none;
  margin-bottom:2px
}
.nav-item:hover{background:var(--bg4);color:var(--text)}
.nav-item.active{background:var(--bg5);color:var(--brand)}
.nav-item svg{flex-shrink:0;width:16px;height:16px}
.nav-label{font-size:13px;font-weight:500}

/* Sidebar footer */
#sb-footer{
  padding:12px 16px;border-top:1px solid var(--border);
  display:flex;flex-direction:column;gap:10px
}
#conn-status{
  display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)
}
.conn-dot{
  width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0
}
.conn-dot.online{
  background:var(--brand);
  animation:pulse 2s cubic-bezier(.4,0,.6,1) infinite
}
.conn-dot.offline{background:var(--red)}
@keyframes pulse{
  0%,100%{opacity:1}
  50%{opacity:.4}
}
#theme-btn{
  display:flex;align-items:center;gap:8px;
  padding:7px 10px;border-radius:8px;border:1px solid var(--border2);
  background:var(--input-bg);color:var(--muted);
  cursor:pointer;font-size:12px;font-family:inherit;
  transition:all .15s;width:100%
}
#theme-btn:hover{background:var(--bg4);color:var(--text);border-color:var(--brand)}

/* ── Main content ── */
#main{flex:1;overflow-y:auto;background:var(--bg);padding:28px 32px;transition:background .15s}

/* ── Page header ── */
.page-header{margin-bottom:24px}
.page-title{font-size:22px;font-weight:700;color:var(--text);letter-spacing:-.3px}
.page-sub{font-size:13px;color:var(--muted);margin-top:4px}

/* ── Stat cards grid ── */
.stat-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:14px;margin-bottom:24px
}
.stat-card{
  background:var(--card-bg);border:1px solid var(--card-border);
  border-radius:12px;padding:18px 20px;
  transition:border-color .15s,background .15s
}
.stat-card:hover{border-color:var(--border2)}
.stat-card.accent-green{border-color:rgba(22,163,74,.35)}
.stat-card .label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px}
.stat-card .value{font-size:28px;font-weight:700;color:var(--text);letter-spacing:-.5px;line-height:1}
.stat-card .value.green{color:var(--brand-light)}
.stat-card .sub{font-size:12px;color:var(--muted);margin-top:5px}

/* ── Section ── */
.section{margin-bottom:24px}
.section-title{
  font-size:13px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.6px;
  margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)
}

/* ── Tools bar chart ── */
.tools-list{display:flex;flex-direction:column;gap:8px}
.tool-row{display:flex;align-items:center;gap:10px}
.tool-name{
  font-size:12px;font-family:'Cascadia Code','Fira Mono',Consolas,monospace;
  color:var(--text2);width:120px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis
}
.tool-bar-wrap{flex:1;background:var(--bg4);border-radius:4px;height:8px;overflow:hidden}
.tool-bar{height:100%;background:var(--brand);border-radius:4px;transition:width .5s ease}
.tool-count{font-size:12px;color:var(--muted);width:52px;text-align:right;flex-shrink:0}

/* ── Latency pills ── */
.latency-row{display:flex;gap:10px;flex-wrap:wrap}
.lat-pill{
  display:flex;flex-direction:column;align-items:center;
  padding:10px 20px;border-radius:10px;
  background:var(--card-bg);border:1px solid var(--card-border);min-width:100px
}
.lat-pill .lat-label{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.lat-pill .lat-val{font-size:20px;font-weight:700;color:var(--text);margin-top:4px}
.lat-pill .lat-unit{font-size:11px;color:var(--muted)}

/* ── Cache row ── */
.cache-row{
  display:flex;gap:14px;flex-wrap:wrap
}
.cache-card{
  background:var(--card-bg);border:1px solid var(--card-border);
  border-radius:10px;padding:14px 20px;flex:1;min-width:140px
}
.cache-card .c-label{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.cache-card .c-val{font-size:22px;font-weight:700;color:var(--text)}
.cache-card .c-sub{font-size:11px;color:var(--muted);margin-top:3px}

/* ── Status / controls ── */
.status-section{
  background:var(--card-bg);border:1px solid var(--card-border);
  border-radius:12px;padding:18px 20px
}
.status-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.mode-badge{
  display:inline-flex;align-items:center;gap:5px;
  padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;
  background:rgba(22,163,74,.15);color:var(--brand-light);border:1px solid rgba(22,163,74,.3)
}
.mode-badge.off{background:rgba(239,68,68,.1);color:#f87171;border-color:rgba(239,68,68,.25)}
.mode-badge.bypassed{background:rgba(234,179,8,.1);color:#fbbf24;border-color:rgba(234,179,8,.25)}

.btn-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mode-btn{
  padding:6px 14px;border-radius:8px;border:1px solid var(--border2);
  background:var(--input-bg);color:var(--muted);font-size:12px;font-family:inherit;
  cursor:pointer;transition:all .15s;font-weight:500
}
.mode-btn:hover{background:var(--bg4);color:var(--text);border-color:var(--border2)}
.mode-btn.active{background:rgba(22,163,74,.15);color:var(--brand-light);border-color:rgba(22,163,74,.4)}
.mode-btn.active-off{background:rgba(239,68,68,.1);color:#f87171;border-color:rgba(239,68,68,.3)}
.btn-divider{width:1px;height:24px;background:var(--border2)}
.bypass-btn{
  padding:6px 14px;border-radius:8px;border:1px solid var(--border2);
  background:var(--input-bg);color:var(--muted);font-size:12px;font-family:inherit;
  cursor:pointer;transition:all .15s;font-weight:500
}
.bypass-btn:hover{background:var(--bg4);color:var(--text)}
.bypass-btn.active{background:rgba(234,179,8,.1);color:#fbbf24;border-color:rgba(234,179,8,.3)}

/* ── Settings page ── */
.settings-group{
  background:var(--card-bg);border:1px solid var(--card-border);
  border-radius:12px;overflow:hidden;margin-bottom:20px
}
.settings-group-title{
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;
  color:var(--muted);padding:12px 20px 10px;
  border-bottom:1px solid var(--border);background:var(--bg3)
}
.settings-row{
  display:flex;align-items:center;padding:13px 20px;
  border-bottom:1px solid var(--border);gap:12px
}
.settings-row:last-child{border-bottom:none}
.settings-key{
  font-size:13px;color:var(--muted);width:220px;flex-shrink:0
}
.settings-val{
  font-size:13px;color:var(--text);font-family:'Cascadia Code','Fira Mono',Consolas,monospace;
  flex:1
}
.settings-val code{
  background:var(--bg4);padding:2px 8px;border-radius:5px;
  font-size:12px;color:var(--text2);border:1px solid var(--border)
}

/* ── CLI chips ── */
.cli-chips{display:flex;flex-wrap:wrap;gap:8px;padding:16px 20px}
.cli-chip{
  display:flex;align-items:center;gap:6px;
  padding:6px 14px;border-radius:20px;
  background:var(--bg4);border:1px solid var(--border2);
  font-size:12px;color:var(--text2);font-weight:500
}
.cli-chip .chip-dot{
  width:6px;height:6px;border-radius:50%;background:var(--brand);flex-shrink:0
}

/* ── Uptime badge ── */
.uptime-val{color:var(--brand-light) !important}

/* ── Empty / loading ── */
.skeleton{
  background:linear-gradient(90deg,var(--bg4) 25%,var(--bg5) 50%,var(--bg4) 75%);
  background-size:200% 100%;
  animation:shimmer 1.4s infinite;border-radius:6px;
  height:32px;width:80%
}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}

/* ── Responsive ── */
@media(max-width:700px){
  #sidebar{width:56px}
  #sb-brand .brand-text,#sb-footer #conn-label,#sb-footer #theme-label,.nav-label{display:none}
  #main{padding:16px}
}
</style>
</head>
<body>
<div id="app">

  <!-- ── Sidebar ── -->
  <aside id="sidebar">
    <div id="sb-brand">
      <svg class="logo-svg" viewBox="0 0 427 425" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M354.982 369.122C349.882 371.592 338.752 371.792 330.442 369.562C314.752 365.342 292.762 350.502 274.462 331.772L269.022 326.202L268.322 308.932C267.942 299.432 267.332 289.862 266.972 287.662C266.612 285.462 265.842 280.742 265.252 277.162C261.922 256.872 253.782 233.162 245.022 218.222C241.322 211.902 240.442 208.162 242.662 208.162C246.992 208.162 272.062 220.332 283.912 228.172C307.882 244.042 340.042 276.312 356.142 300.642C361.992 309.492 368.862 323.942 370.862 331.632C372.842 339.222 372.822 343.952 370.782 350.952C368.862 357.572 361.602 365.922 354.982 369.122ZM218.282 179.832C214.632 182.212 211.352 184.162 210.992 184.162C209.782 184.162 209.192 181.162 209.872 178.472C211.522 171.892 223.622 148.592 229.912 139.892C238.462 128.072 255.812 107.752 262.572 101.652C289.962 76.9417 301.752 68.0317 317.642 60.0417C337.182 50.2217 355.782 51.3217 365.342 62.8817C368.722 66.9617 372.412 77.3217 372.412 82.7217C372.412 92.2417 366.082 109.302 358.222 120.942C352.882 128.862 338.112 146.372 331.782 152.282L327.912 155.902L306.412 157.012C275.532 158.602 257.232 162.282 234.992 171.372C229.442 173.642 221.922 177.442 218.282 179.832ZM192.352 192.912C191.862 194.152 190.962 195.162 190.372 195.162C188.672 195.162 180.862 177.712 177.542 166.472C172.022 147.832 170.142 131.892 170.112 103.662C170.072 54.9617 176.632 25.5317 190.962 10.2117C203.612 -3.30832 223.802 -3.41833 235.432 9.97167C246.502 22.7117 252.932 45.4017 254.122 75.8417L254.712 91.0217L243.802 102.342C216.642 130.552 201.082 156.292 194.952 183.172C194.012 187.292 192.842 191.672 192.352 192.912ZM226.572 421.482C220.292 424.892 210.782 425.902 205.022 423.752C191.282 418.632 180.692 404.292 175.412 383.662C172.812 373.502 170.052 347.602 170.692 339.372L171.192 333.072L181.082 322.872C198.422 304.992 208.702 290.782 219.092 270.362C225.192 258.372 231.412 241.452 231.412 236.842C231.412 233.222 233.922 230.432 236.032 231.722C240.442 234.432 249.472 263.122 253.062 285.842C255.302 300.022 255.592 348.712 253.532 363.662C249.272 394.512 240.142 414.092 226.572 421.482ZM182.052 209.772C186.532 217.502 181.062 217.082 163.912 208.392C143.982 198.302 124.292 183.882 105.542 165.662C69.9124 131.042 51.3724 100.292 53.7824 79.7817C54.5824 72.9217 59.4624 62.9817 63.5724 59.8517C83.1924 44.8917 111.392 54.5117 145.162 87.6917L156.412 98.7517L156.422 107.702C156.442 128.452 159.472 151.202 164.592 169.092C169.372 185.812 172.862 193.952 182.052 209.772ZM96.0524 369.042C86.6124 371.962 77.4224 371.862 70.9124 368.772C60.5924 363.872 53.4124 352.582 53.4124 341.252C53.4124 325.142 66.4924 301.572 87.9324 279.062C93.8424 272.852 96.3824 270.182 99.4924 269.032C101.842 268.152 104.522 268.152 109.242 268.152C131.112 268.132 157.482 264.312 174.912 258.642C183.912 255.722 201.562 247.552 208.502 243.102C211.022 241.482 213.612 240.162 214.252 240.162C216.572 240.162 215.322 246.362 211.052 256.062C201.052 278.772 190.362 293.692 165.912 319.032C140.952 344.912 115.702 362.982 96.0524 369.042ZM368.762 251.622C362.292 252.472 351.732 253.162 345.312 253.162H333.622L328.262 247.552C314.672 233.322 289.892 214.982 271.112 205.242C261.472 200.242 244.592 193.972 237.082 192.602C232.942 191.852 231.502 189.962 233.362 187.722C235.062 185.672 250.402 179.462 259.532 177.132C280.552 171.762 296.062 170.162 326.772 170.172C369.092 170.192 394.642 174.902 410.892 185.692C419.312 191.282 423.272 197.242 425.392 207.512C426.482 212.822 426.382 214.032 424.312 220.512C422.492 226.212 420.942 228.802 416.682 233.292C413.742 236.392 408.742 240.302 405.572 241.992C398.302 245.872 383.912 249.632 368.762 251.622ZM146.412 251.272C136.432 253.162 130.742 253.482 103.412 253.742C80.9524 253.952 69.0424 253.652 61.9124 252.682C28.4924 248.142 11.0524 240.212 3.39238 226.092C0.252382 220.292 -0.0776191 218.932 0.0123809 212.162C0.142381 202.882 1.92238 198.622 8.60238 191.562C20.8324 178.622 39.5124 173.102 76.4624 171.502L91.0124 170.862L104.492 182.762C125.782 201.552 128.872 203.902 142.912 211.932C160.322 221.882 182.112 231.162 188.092 231.162C189.152 231.162 190.902 231.842 191.972 232.662C193.862 234.132 193.832 234.242 190.912 236.652C184.902 241.622 167.932 247.202 146.412 251.272Z" fill="currentColor"/>
      </svg>
      <div class="brand-text">
        <div class="name">Squeezr</div>
        <div class="ver" id="sb-version">—</div>
      </div>
    </div>

    <nav>
      <div class="nav-item active" data-page="home" onclick="navigate('home')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/><polyline points="9 21 9 12 15 12 15 21"/>
        </svg>
        <span class="nav-label">Home</span>
      </div>
      <div class="nav-item" data-page="settings" onclick="navigate('settings')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span class="nav-label">Settings</span>
      </div>
    </nav>

    <div id="sb-footer">
      <div id="conn-status">
        <div class="conn-dot" id="conn-dot"></div>
        <span id="conn-label">Connecting…</span>
      </div>
      <button id="theme-btn" onclick="toggleTheme()" title="Toggle dark/light mode">
        <span id="theme-icon">☀️</span>
        <span id="theme-label">Light mode</span>
      </button>
    </div>
  </aside>

  <!-- ── Main ── -->
  <main id="main">
    <!-- Home page -->
    <div id="page-home">
      <div class="page-header">
        <div class="page-title">Overview</div>
        <div class="page-sub">Live stats — updates via server-sent events</div>
      </div>

      <!-- Hero stat cards -->
      <div class="stat-grid">
        <div class="stat-card accent-green">
          <div class="label">Tokens Saved</div>
          <div class="value green" id="s-tokens-saved">—</div>
          <div class="sub" id="s-tokens-sub">of <span id="s-tokens-in">—</span> in</div>
        </div>
        <div class="stat-card">
          <div class="label">Compression Ratio</div>
          <div class="value" id="s-ratio">—</div>
          <div class="sub">avg across all requests</div>
        </div>
        <div class="stat-card">
          <div class="label">Cost Saved</div>
          <div class="value" id="s-cost">—</div>
          <div class="sub">estimated USD</div>
        </div>
        <div class="stat-card">
          <div class="label">Requests Proxied</div>
          <div class="value" id="s-requests">—</div>
          <div class="sub"><span id="s-compressed">—</span> compressed</div>
        </div>
      </div>

      <!-- Tools section -->
      <div class="section">
        <div class="section-title">Top Tools by Request</div>
        <div class="tools-list" id="tools-list">
          <div class="skeleton"></div>
        </div>
      </div>

      <!-- Latency section -->
      <div class="section">
        <div class="section-title">Latency</div>
        <div class="latency-row">
          <div class="lat-pill">
            <span class="lat-label">p50</span>
            <span class="lat-val" id="l-p50">—</span>
            <span class="lat-unit">ms</span>
          </div>
          <div class="lat-pill">
            <span class="lat-label">p95</span>
            <span class="lat-val" id="l-p95">—</span>
            <span class="lat-unit">ms</span>
          </div>
          <div class="lat-pill">
            <span class="lat-label">p99</span>
            <span class="lat-val" id="l-p99">—</span>
            <span class="lat-unit">ms</span>
          </div>
        </div>
      </div>

      <!-- Cache section -->
      <div class="section">
        <div class="section-title">Cache</div>
        <div class="cache-row">
          <div class="cache-card">
            <div class="c-label">Hits</div>
            <div class="c-val" id="c-hits">—</div>
            <div class="c-sub">served from cache</div>
          </div>
          <div class="cache-card">
            <div class="c-label">Misses</div>
            <div class="c-val" id="c-miss">—</div>
            <div class="c-sub">forwarded upstream</div>
          </div>
          <div class="cache-card">
            <div class="c-label">Hit Rate</div>
            <div class="c-val" id="c-rate">—</div>
            <div class="c-sub">percentage</div>
          </div>
        </div>
      </div>

      <!-- Status & controls -->
      <div class="section">
        <div class="section-title">Status &amp; Controls</div>
        <div class="status-section">
          <div class="status-row">
            <span style="font-size:13px;color:var(--muted)">Mode:</span>
            <span class="mode-badge" id="mode-badge">normal</span>
            <span style="font-size:13px;color:var(--muted);margin-left:12px">Bypass:</span>
            <span class="mode-badge" id="bypass-badge">off</span>
          </div>
          <div class="btn-row">
            <button class="mode-btn" data-mode="off" onclick="setMode('off')">off</button>
            <button class="mode-btn" data-mode="low" onclick="setMode('low')">low</button>
            <button class="mode-btn active" data-mode="normal" onclick="setMode('normal')">normal</button>
            <button class="mode-btn" data-mode="aggressive" onclick="setMode('aggressive')">aggressive</button>
            <div class="btn-divider"></div>
            <button class="bypass-btn" id="bypass-btn" onclick="toggleBypass()">Toggle Bypass</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Settings page -->
    <div id="page-settings" style="display:none">
      <div class="page-header">
        <div class="page-title">Settings</div>
        <div class="page-sub">Current proxy configuration and environment</div>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">Proxy</div>
        <div class="settings-row">
          <span class="settings-key">ANTHROPIC_BASE_URL</span>
          <span class="settings-val"><code>http://localhost:3284</code></span>
        </div>
        <div class="settings-row">
          <span class="settings-key">MITM Port</span>
          <span class="settings-val"><code>3284</code></span>
        </div>
        <div class="settings-row">
          <span class="settings-key">Version</span>
          <span class="settings-val" id="cfg-version"><code>—</code></span>
        </div>
        <div class="settings-row">
          <span class="settings-key">Uptime</span>
          <span class="settings-val uptime-val" id="cfg-uptime">—</span>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">Compression</div>
        <div class="settings-row">
          <span class="settings-key">Mode</span>
          <span class="settings-val" id="cfg-mode"><code>normal</code></span>
        </div>
        <div class="settings-row">
          <span class="settings-key">Circuit Breaker</span>
          <span class="settings-val" id="cfg-cb"><code>—</code></span>
        </div>
        <div class="settings-row">
          <span class="settings-key">Bypass</span>
          <span class="settings-val" id="cfg-bypass"><code>—</code></span>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">Connected CLIs</div>
        <div class="cli-chips">
          <div class="cli-chip"><div class="chip-dot"></div>Claude Code</div>
          <div class="cli-chip"><div class="chip-dot"></div>Cursor</div>
          <div class="cli-chip"><div class="chip-dot"></div>Codex Desktop</div>
          <div class="cli-chip"><div class="chip-dot"></div>Aider</div>
          <div class="cli-chip"><div class="chip-dot"></div>Gemini CLI</div>
          <div class="cli-chip"><div class="chip-dot"></div>Continue.dev</div>
          <div class="cli-chip"><div class="chip-dot"></div>Cline</div>
          <div class="cli-chip"><div class="chip-dot"></div>Windsurf</div>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
// ── Theme ──────────────────────────────────────────────────────────────────
(function(){
  var saved = localStorage.getItem('sq-theme') || 'dark';
  applyTheme(saved);
})();

function applyTheme(t) {
  if (t === 'dark') {
    document.documentElement.classList.add('dark');
    var btn = document.getElementById('theme-btn');
    if (btn) {
      document.getElementById('theme-icon').textContent = '☀️';
      document.getElementById('theme-label').textContent = 'Light mode';
    }
  } else {
    document.documentElement.classList.remove('dark');
    var btn = document.getElementById('theme-btn');
    if (btn) {
      document.getElementById('theme-icon').textContent = '🌙';
      document.getElementById('theme-label').textContent = 'Dark mode';
    }
  }
  localStorage.setItem('sq-theme', t);
}

function toggleTheme() {
  var isDark = document.documentElement.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
}

// ── Navigation ─────────────────────────────────────────────────────────────
var currentPage = 'home';

function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.page === page);
  });
  document.getElementById('page-home').style.display = page === 'home' ? '' : 'none';
  document.getElementById('page-settings').style.display = page === 'settings' ? '' : 'none';
}

// ── Formatting helpers ─────────────────────────────────────────────────────
function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtRatio(r) {
  if (r == null) return '—';
  return Math.round(r * 100) + '%';
}

function fmtUsd(v) {
  if (v == null) return '—';
  return '$' + Number(v).toFixed(2);
}

function fmtUptime(s) {
  if (s == null) return '—';
  var d = Math.floor(s / 86400);
  var h = Math.floor((s % 86400) / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
  if (m > 0) return m + 'm ' + sec + 's';
  return sec + 's';
}

// ── Render stats ───────────────────────────────────────────────────────────
var lastStats = null;

function renderStats(d) {
  if (!d) return;
  lastStats = d;

  // version in sidebar
  if (d.version) {
    document.getElementById('sb-version').textContent = 'v' + d.version;
  }

  // Hero cards
  document.getElementById('s-tokens-saved').textContent = fmtNum(d.tokens_saved);
  document.getElementById('s-tokens-in').textContent = fmtNum(d.tokens_in);
  document.getElementById('s-ratio').textContent = fmtRatio(d.compression_ratio);
  document.getElementById('s-cost').textContent = fmtUsd(d.cost_saved_usd);
  document.getElementById('s-requests').textContent = fmtNum(d.total_requests);
  document.getElementById('s-compressed').textContent = fmtNum(d.compressed);

  // Latency
  document.getElementById('l-p50').textContent = d.latency_p50 != null ? d.latency_p50 : '—';
  document.getElementById('l-p95').textContent = d.latency_p95 != null ? d.latency_p95 : '—';
  document.getElementById('l-p99').textContent = d.latency_p99 != null ? d.latency_p99 : '—';

  // Cache
  var hits = d.cache_hits || 0;
  var miss = d.cache_miss || 0;
  var total = hits + miss;
  document.getElementById('c-hits').textContent = fmtNum(hits);
  document.getElementById('c-miss').textContent = fmtNum(miss);
  document.getElementById('c-rate').textContent = total > 0 ? Math.round(hits / total * 100) + '%' : '—';

  // Tools chart
  renderTools(d.tools);

  // Mode badge + buttons
  var mode = d.mode || 'normal';
  var bypassed = !!d.bypass;
  updateModeUI(mode, bypassed);

  // Settings page
  if (d.version) document.getElementById('cfg-version').innerHTML = '<code>' + d.version + '</code>';
  if (d.uptime_seconds != null) document.getElementById('cfg-uptime').textContent = fmtUptime(d.uptime_seconds);
  document.getElementById('cfg-mode').innerHTML = '<code>' + mode + '</code>';
  document.getElementById('cfg-bypass').innerHTML = '<code>' + (bypassed ? 'enabled' : 'disabled') + '</code>';

  if (d.circuit_breaker) {
    var cb = d.circuit_breaker;
    document.getElementById('cfg-cb').innerHTML =
      '<code>' + cb.state + (cb.total_trips != null ? ' · ' + cb.total_trips + ' trips' : '') + '</code>';
  }
}

function updateModeUI(mode, bypassed) {
  // badge
  var mb = document.getElementById('mode-badge');
  mb.textContent = mode;
  mb.className = 'mode-badge' + (mode === 'off' ? ' off' : '');

  var bb = document.getElementById('bypass-badge');
  bb.textContent = bypassed ? 'on' : 'off';
  bb.className = 'mode-badge' + (bypassed ? ' bypassed' : '');

  // mode buttons
  document.querySelectorAll('.mode-btn').forEach(function(btn) {
    btn.className = 'mode-btn';
    if (btn.dataset.mode === mode) {
      btn.className = 'mode-btn ' + (mode === 'off' ? 'active-off' : 'active');
    }
  });

  // bypass button
  document.getElementById('bypass-btn').className = 'bypass-btn' + (bypassed ? ' active' : '');
}

// ── Tools bar chart ────────────────────────────────────────────────────────
function renderTools(tools) {
  var container = document.getElementById('tools-list');
  if (!tools || typeof tools !== 'object') {
    container.innerHTML = '<span style="color:var(--muted);font-size:12px">No tool data available</span>';
    return;
  }

  var entries = Object.entries(tools)
    .filter(function(e) { return e[1] > 0; })
    .sort(function(a, b) { return b[1] - a[1]; })
    .slice(0, 5);

  if (entries.length === 0) {
    container.innerHTML = '<span style="color:var(--muted);font-size:12px">No tools recorded yet</span>';
    return;
  }

  var max = entries[0][1];
  container.innerHTML = entries.map(function(e) {
    var pct = max > 0 ? Math.round(e[1] / max * 100) : 0;
    return '<div class="tool-row">' +
      '<span class="tool-name">' + escHtml(e[0]) + '</span>' +
      '<div class="tool-bar-wrap"><div class="tool-bar" style="width:' + pct + '%"></div></div>' +
      '<span class="tool-count">' + fmtNum(e[1]) + '</span>' +
      '</div>';
  }).join('');
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Mode / Bypass controls ─────────────────────────────────────────────────
function setMode(mode) {
  fetch('/squeezr/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: mode })
  }).then(function(r) {
    if (r.ok) {
      if (lastStats) {
        lastStats.mode = mode;
        updateModeUI(mode, !!(lastStats && lastStats.bypass));
      }
    }
  }).catch(function(e) { console.error('setMode failed', e); });
}

function toggleBypass() {
  fetch('/squeezr/bypass', { method: 'POST' })
    .then(function(r) {
      if (r.ok) refreshStats();
    })
    .catch(function(e) { console.error('toggleBypass failed', e); });
}

// ── SSE + polling fallback ─────────────────────────────────────────────────
var pollTimer = null;
var sseActive = false;

function refreshStats() {
  fetch('/squeezr/stats')
    .then(function(r) { return r.json(); })
    .then(renderStats)
    .catch(function(e) { console.error('stats poll failed', e); });
}

function setConnected(ok) {
  var dot = document.getElementById('conn-dot');
  var label = document.getElementById('conn-label');
  if (ok) {
    dot.className = 'conn-dot online';
    label.textContent = 'Connected';
  } else {
    dot.className = 'conn-dot offline';
    label.textContent = 'Offline';
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshStats, 5000);
  refreshStats();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function connect() {
  var es;
  try {
    es = new EventSource('/squeezr/events');
  } catch(e) {
    setConnected(false);
    startPolling();
    return;
  }

  var timeout = setTimeout(function() {
    // SSE hasn't fired in 6s — fall back to polling
    if (!sseActive) {
      es.close();
      setConnected(false);
      startPolling();
    }
  }, 6000);

  es.onopen = function() {
    clearTimeout(timeout);
    sseActive = true;
    stopPolling();
    setConnected(true);
  };

  es.onmessage = function(ev) {
    clearTimeout(timeout);
    if (!sseActive) {
      sseActive = true;
      stopPolling();
      setConnected(true);
    }
    try {
      var data = JSON.parse(ev.data);
      renderStats(data);
    } catch(e) { /* ignore malformed */ }
  };

  es.addEventListener('stats', function(ev) {
    try {
      var data = JSON.parse(ev.data);
      renderStats(data);
    } catch(e) {}
  });

  es.onerror = function() {
    clearTimeout(timeout);
    sseActive = false;
    es.close();
    setConnected(false);
    startPolling();
    // retry SSE after 10s
    setTimeout(connect, 10000);
  };
}

// Initial load
refreshStats();
connect();
</script>
</body>
</html>`;
