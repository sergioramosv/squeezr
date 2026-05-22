/**
 * Squeezr Dashboard — single-file SPA
 * Pages: Overview + Settings only.
 * Dark/light mode, SSE + polling fallback, zero external deps.
 */

export const DASHBOARD_HTML = /* html */`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Squeezr</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}

:root{
  --bg:#0a0a0a;
  --surface:#111111;
  --surface2:#161616;
  --surface3:#1c1c1c;
  --border:#222222;
  --border2:#2e2e2e;
  --text:#f0f0f0;
  --text2:#a0a0a0;
  --text3:#606060;
  --brand:#16a34a;
  --brand2:#4ade80;
  --brand-dim:rgba(22,163,74,.12);
  --brand-dim2:rgba(22,163,74,.06);
  --red:#f87171;
  --yellow:#fbbf24;
  --blue:#60a5fa;
  --shadow:0 1px 3px rgba(0,0,0,.5),0 4px 16px rgba(0,0,0,.3);
}
html:not(.dark){
  --bg:#f5f5f5;
  --surface:#ffffff;
  --surface2:#fafafa;
  --surface3:#f0f0f0;
  --border:#e0e0e0;
  --border2:#d0d0d0;
  --text:#111111;
  --text2:#555555;
  --text3:#999999;
  --brand-dim:rgba(22,163,74,.08);
  --brand-dim2:rgba(22,163,74,.04);
  --shadow:0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06);
}

html,body{
  height:100%;
  background:var(--bg);
  color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;
  font-size:14px;line-height:1.5;
  transition:background .2s,color .2s;
  -webkit-font-smoothing:antialiased;
}
code{font-family:'Cascadia Code','SF Mono',Consolas,monospace;font-size:.9em}

/* ── Layout ── */
#app{display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── Top navbar ── */
#navbar{
  flex-shrink:0;
  height:52px;
  background:var(--surface);
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;
  padding:0 24px;gap:0;
  transition:background .2s,border-color .2s
}

/* Logo */
.nb-brand{
  display:flex;align-items:center;gap:9px;
  margin-right:24px;flex-shrink:0
}
.nb-brand svg{width:24px;height:24px;color:var(--brand)}
.nb-brand-name{font-size:15px;font-weight:700;letter-spacing:-.3px;color:var(--text)}
.nb-brand-ver{font-size:11px;color:var(--text3);margin-left:6px;margin-top:1px}

/* Divider */
.nb-sep{width:1px;height:22px;background:var(--border2);margin-right:20px;flex-shrink:0}

/* Tabs */
.nb-tabs{display:flex;align-items:stretch;gap:2px;height:100%}
.nb-tab{
  display:flex;align-items:center;gap:7px;
  padding:0 16px;
  font-size:13px;font-weight:500;color:var(--text2);
  cursor:pointer;user-select:none;
  border-bottom:2px solid transparent;
  transition:color .12s,border-color .12s;
  white-space:nowrap
}
.nb-tab:hover{color:var(--text)}
.nb-tab.active{color:var(--brand);border-bottom-color:var(--brand)}
.nb-tab svg{width:14px;height:14px;flex-shrink:0;stroke-width:2}

/* Right side */
.nb-right{
  margin-left:auto;display:flex;align-items:center;gap:10px
}
.conn-dot{
  width:7px;height:7px;border-radius:50%;background:var(--text3);flex-shrink:0;
  transition:background .3s
}
.conn-dot.online{background:var(--brand);box-shadow:0 0 6px var(--brand)}
.conn-dot.offline{background:var(--red)}
.conn-label{font-size:12px;color:var(--text3)}

.theme-btn{
  display:flex;align-items:center;justify-content:center;
  width:32px;height:32px;border-radius:8px;
  background:none;border:1px solid var(--border2);cursor:pointer;
  color:var(--text2);transition:background .12s,color .12s
}
.theme-btn:hover{background:var(--surface3);color:var(--text)}

/* ── Main ── */
#main{
  flex:1;overflow-y:auto;padding:28px 32px;
  background:var(--bg)
}
@media(max-width:600px){
  .nb-brand-ver{display:none}
  #main{padding:16px 14px}
}

.page-header{margin-bottom:24px}
.page-title{font-size:22px;font-weight:700;letter-spacing:-.4px;color:var(--text)}
.page-sub{font-size:13px;color:var(--text3);margin-top:3px}

/* ── Hero cards ── */
.hero-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  gap:12px;margin-bottom:20px
}
.hero-card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:12px;padding:18px 20px;
  box-shadow:var(--shadow);
  transition:border-color .15s
}
.hero-card:hover{border-color:var(--border2)}
.hero-card.accent{
  background:var(--brand-dim);
  border-color:rgba(22,163,74,.25)
}
.hc-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);margin-bottom:8px}
.hc-val{font-size:30px;font-weight:800;letter-spacing:-.5px;color:var(--text);line-height:1}
.hero-card.accent .hc-val{color:var(--brand2)}
.hc-sub{font-size:11px;color:var(--text3);margin-top:6px}

/* ── Sections ── */
.section{
  background:var(--surface);border:1px solid var(--border);
  border-radius:12px;margin-bottom:16px;overflow:hidden;
  box-shadow:var(--shadow)
}
.section-head{
  padding:14px 20px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between
}
.section-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text3)}
.section-body{padding:16px 20px}

/* ── Tools bars ── */
.tool-row{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.tool-row:last-child{margin-bottom:0}
.tool-name{font-size:13px;color:var(--text2);width:90px;flex-shrink:0;font-weight:500}
.tool-track{flex:1;height:6px;background:var(--surface3);border-radius:3px;overflow:hidden}
.tool-fill{height:100%;background:var(--brand);border-radius:3px;transition:width .4s}
.tool-count{font-size:12px;color:var(--text3);width:50px;text-align:right;font-variant-numeric:tabular-nums}

/* ── Latency pills ── */
.lat-row{display:flex;gap:10px;flex-wrap:wrap}
.lat-pill{
  flex:1;min-width:80px;
  background:var(--surface2);border:1px solid var(--border2);
  border-radius:10px;padding:12px 16px;text-align:center
}
.lat-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);display:block;margin-bottom:4px}
.lat-val{font-size:22px;font-weight:700;color:var(--text)}
.lat-unit{font-size:11px;color:var(--text3)}

/* ── Cache row ── */
.cache-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.cache-card{
  background:var(--surface2);border:1px solid var(--border2);
  border-radius:10px;padding:14px;text-align:center
}
.cache-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:6px}
.cache-val{font-size:22px;font-weight:700;color:var(--text)}

/* ── Limits ── */
.limits-grid{display:flex;flex-direction:column;gap:10px}
.lim-row{display:flex;align-items:center;gap:14px}
.lim-name{font-size:12px;color:var(--text2);width:100px;flex-shrink:0;font-weight:500}
.lim-track{flex:1;height:8px;background:var(--surface3);border-radius:4px;overflow:hidden}
.lim-fill{height:100%;border-radius:4px;transition:width .5s,background .3s}
.lim-fill.ok{background:var(--brand)}
.lim-fill.warn{background:var(--yellow)}
.lim-fill.crit{background:var(--red)}
.lim-text{font-size:12px;color:var(--text3);width:90px;text-align:right;font-variant-numeric:tabular-nums}
.lim-nodata{font-size:13px;color:var(--text3);padding:8px 0}

/* ── Mode controls ── */
.controls-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mode-btn{
  padding:7px 16px;border-radius:8px;
  border:1px solid var(--border2);background:var(--surface2);
  color:var(--text2);font-size:12px;font-weight:600;font-family:inherit;
  cursor:pointer;transition:all .12s
}
.mode-btn:hover{border-color:var(--brand);color:var(--brand)}
.mode-btn.active{background:var(--brand-dim);border-color:rgba(22,163,74,.4);color:var(--brand2)}
.mode-btn.active-off{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.3);color:var(--red)}
.divider-v{width:1px;height:24px;background:var(--border2)}
.bypass-btn{
  padding:7px 16px;border-radius:8px;
  border:1px solid var(--border2);background:var(--surface2);
  color:var(--text2);font-size:12px;font-weight:600;font-family:inherit;
  cursor:pointer;transition:all .12s
}
.bypass-btn:hover{border-color:var(--yellow);color:var(--yellow)}
.bypass-btn.active{background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.3);color:var(--yellow)}

/* ── Status badges ── */
.badge-row{display:flex;gap:8px;margin-bottom:14px}
.badge{
  font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;
  border:1px solid var(--border2);color:var(--text3);background:var(--surface2)
}
.badge.green{background:var(--brand-dim);border-color:rgba(22,163,74,.3);color:var(--brand2)}
.badge.yellow{background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.25);color:var(--yellow)}
.badge.red{background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.25);color:var(--red)}

/* ── Settings ── */
.settings-block{
  background:var(--surface);border:1px solid var(--border);
  border-radius:12px;overflow:hidden;margin-bottom:16px;
  box-shadow:var(--shadow)
}
.settings-head{
  padding:12px 20px;border-bottom:1px solid var(--border);
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;
  color:var(--text3);background:var(--surface2)
}
.settings-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:13px 20px;border-bottom:1px solid var(--border);gap:16px
}
.settings-row:last-child{border-bottom:none}
.s-key{font-size:13px;color:var(--text2);font-weight:500}
.s-val{font-size:13px;color:var(--text);font-family:'Cascadia Code','SF Mono',Consolas,monospace}
.s-val code{
  background:var(--surface3);padding:2px 8px;border-radius:5px;
  border:1px solid var(--border2);color:var(--text)
}

/* ── Action buttons ── */
.action-btn{padding:7px 18px;border-radius:8px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:13px;font-family:inherit;cursor:pointer;font-weight:500;transition:all .12s}
.action-btn:hover{border-color:var(--brand);color:var(--brand)}
.action-btn.danger{border-color:rgba(248,113,113,.3);color:var(--red)}
.action-btn.danger:hover{background:rgba(248,113,113,.08)}
.action-result{margin-top:10px;font-size:12px;padding:8px 12px;border-radius:6px;display:none}
.action-result.ok{background:rgba(22,163,74,.08);color:#4ade80;border:1px solid rgba(22,163,74,.2)}
.action-result.err{background:rgba(248,113,113,.08);color:#f87171;border:1px solid rgba(248,113,113,.2)}

/* ── CLI chips ── */
.chips{display:flex;flex-wrap:wrap;gap:7px;padding:16px 20px}
.chip{
  display:flex;align-items:center;gap:5px;
  padding:5px 12px;border-radius:20px;
  background:var(--surface2);border:1px solid var(--border2);
  font-size:12px;color:var(--text2);font-weight:500
}
.chip-dot{width:5px;height:5px;border-radius:50%;background:var(--brand);flex-shrink:0}

/* ── Skeleton ── */
.sk{
  background:linear-gradient(90deg,var(--surface2) 25%,var(--surface3) 50%,var(--surface2) 75%);
  background-size:200% 100%;animation:sk 1.4s infinite;border-radius:6px
}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}

::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
</style>
</head>
<body>
<div id="app">

  <!-- Top navbar -->
  <header id="navbar">
    <div class="nb-brand">
      <svg viewBox="0 0 427 425" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M354.982 369.122C349.882 371.592 338.752 371.792 330.442 369.562C314.752 365.342 292.762 350.502 274.462 331.772L269.022 326.202L268.322 308.932C267.942 299.432 267.332 289.862 266.972 287.662C266.612 285.462 265.842 280.742 265.252 277.162C261.922 256.872 253.782 233.162 245.022 218.222C241.322 211.902 240.442 208.162 242.662 208.162C246.992 208.162 272.062 220.332 283.912 228.172C307.882 244.042 340.042 276.312 356.142 300.642C361.992 309.492 368.862 323.942 370.862 331.632C372.842 339.222 372.822 343.952 370.782 350.952C368.862 357.572 361.602 365.922 354.982 369.122ZM218.282 179.832C214.632 182.212 211.352 184.162 210.992 184.162C209.782 184.162 209.192 181.162 209.872 178.472C211.522 171.892 223.622 148.592 229.912 139.892C238.462 128.072 255.812 107.752 262.572 101.652C289.962 76.9417 301.752 68.0317 317.642 60.0417C337.182 50.2217 355.782 51.3217 365.342 62.8817C368.722 66.9617 372.412 77.3217 372.412 82.7217C372.412 92.2417 366.082 109.302 358.222 120.942C352.882 128.862 338.112 146.372 331.782 152.282L327.912 155.902L306.412 157.012C275.532 158.602 257.232 162.282 234.992 171.372C229.442 173.642 221.922 177.442 218.282 179.832ZM192.352 192.912C191.862 194.152 190.962 195.162 190.372 195.162C188.672 195.162 180.862 177.712 177.542 166.472C172.022 147.832 170.142 131.892 170.112 103.662C170.072 54.9617 176.632 25.5317 190.962 10.2117C203.612 -3.30832 223.802 -3.41833 235.432 9.97167C246.502 22.7117 252.932 45.4017 254.122 75.8417L254.712 91.0217L243.802 102.342C216.642 130.552 201.082 156.292 194.952 183.172C194.012 187.292 192.842 191.672 192.352 192.912ZM226.572 421.482C220.292 424.892 210.782 425.902 205.022 423.752C191.282 418.632 180.692 404.292 175.412 383.662C172.812 373.502 170.052 347.602 170.692 339.372L171.192 333.072L181.082 322.872C198.422 304.992 208.702 290.782 219.092 270.362C225.192 258.372 231.412 241.452 231.412 236.842C231.412 233.222 233.922 230.432 236.032 231.722C240.442 234.432 249.472 263.122 253.062 285.842C255.302 300.022 255.592 348.712 253.532 363.662C249.272 394.512 240.142 414.092 226.572 421.482ZM182.052 209.772C186.532 217.502 181.062 217.082 163.912 208.392C143.982 198.302 124.292 183.882 105.542 165.662C69.9124 131.042 51.3724 100.292 53.7824 79.7817C54.5824 72.9217 59.4624 62.9817 63.5724 59.8517C83.1924 44.8917 111.392 54.5117 145.162 87.6917L156.412 98.7517L156.422 107.702C156.442 128.452 159.472 151.202 164.592 169.092C169.372 185.812 172.862 193.952 182.052 209.772ZM96.0524 369.042C86.6124 371.962 77.4224 371.862 70.9124 368.772C60.5924 363.872 53.4124 352.582 53.4124 341.252C53.4124 325.142 66.4924 301.572 87.9324 279.062C93.8424 272.852 96.3824 270.182 99.4924 269.032C101.842 268.152 104.522 268.152 109.242 268.152C131.112 268.132 157.482 264.312 174.912 258.642C183.912 255.722 201.562 247.552 208.502 243.102C211.022 241.482 213.612 240.162 214.252 240.162C216.572 240.162 215.322 246.362 211.052 256.062C201.052 278.772 190.362 293.692 165.912 319.032C140.952 344.912 115.702 362.982 96.0524 369.042ZM368.762 251.622C362.292 252.472 351.732 253.162 345.312 253.162H333.622L328.262 247.552C314.672 233.322 289.892 214.982 271.112 205.242C261.472 200.242 244.592 193.972 237.082 192.602C232.942 191.852 231.502 189.962 233.362 187.722C235.062 185.672 250.402 179.462 259.532 177.132C280.552 171.762 296.062 170.162 326.772 170.172C369.092 170.192 394.642 174.902 410.892 185.692C419.312 191.282 423.272 197.242 425.392 207.512C426.482 212.822 426.382 214.032 424.312 220.512C422.492 226.212 420.942 228.802 416.682 233.292C413.742 236.392 408.742 240.302 405.572 241.992C398.302 245.872 383.912 249.632 368.762 251.622ZM146.412 251.272C136.432 253.162 130.742 253.482 103.412 253.742C80.9524 253.952 69.0424 253.652 61.9124 252.682C28.4924 248.142 11.0524 240.212 3.39238 226.092C0.252382 220.292 -0.0776191 218.932 0.0123809 212.162C0.142381 202.882 1.92238 198.622 8.60238 191.562C20.8324 178.622 39.5124 173.102 76.4624 171.502L91.0124 170.862L104.492 182.762C125.782 201.552 128.872 203.902 142.912 211.932C160.322 221.882 182.112 231.162 188.092 231.162C189.152 231.162 190.902 231.842 191.972 232.662C193.862 234.132 193.832 234.242 190.912 236.652C184.902 241.622 167.932 247.202 146.412 251.272Z" fill="currentColor"/>
      </svg>
      <span class="nb-brand-name">Squeezr</span>
      <span class="nb-brand-ver" id="sb-ver">—</span>
    </div>

    <div class="nb-sep"></div>

    <div class="nb-tabs">
      <div class="nb-tab active" data-page="overview" onclick="go('overview')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
          <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
        </svg>
        Overview
      </div>
      <div class="nb-tab" data-page="savings" onclick="go('savings')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
        </svg>
        Savings
      </div>
      <div class="nb-tab" data-page="settings" onclick="go('settings')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        Settings
      </div>
    </div>

    <div class="nb-right">
      <div class="conn-dot" id="conn-dot"></div>
      <span class="conn-label" id="conn-label">Connecting…</span>
      <button class="theme-btn" onclick="toggleTheme()" title="Toggle theme">
        <svg id="theme-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
      </button>
    </div>
  </header>

  <!-- Main -->
  <main id="main">

    <!-- ── Overview page ── -->
    <div id="page-overview">

      <!-- Hero stats -->
      <div class="hero-grid">
        <div class="hero-card accent">
          <div class="hc-label">Tokens Saved</div>
          <div class="hc-val" id="h-saved">—</div>
          <div class="hc-sub">of <span id="h-in">—</span> processed</div>
        </div>
        <div class="hero-card">
          <div class="hc-label">Ratio</div>
          <div class="hc-val" id="h-ratio">—</div>
          <div class="hc-sub">compression avg</div>
        </div>
        <div class="hero-card">
          <div class="hc-label">Cost Saved</div>
          <div class="hc-val" id="h-cost">—</div>
          <div class="hc-sub">estimated USD</div>
        </div>
        <div class="hero-card">
          <div class="hc-label">Requests</div>
          <div class="hc-val" id="h-reqs">—</div>
          <div class="hc-sub"><span id="h-comp">—</span> compressed</div>
        </div>
      </div>

      <!-- Controls -->
      <div class="section">
        <div class="section-head">
          <span class="section-title">Compression Mode</span>
          <div class="badge-row" style="margin:0">
            <span class="badge" id="mode-badge">—</span>
            <span class="badge" id="bypass-badge">—</span>
          </div>
        </div>
        <div class="section-body">
          <div class="controls-row">
            <button class="mode-btn" data-mode="off" onclick="setMode('off')">Off</button>
            <button class="mode-btn" data-mode="low" onclick="setMode('low')">Low</button>
            <button class="mode-btn active" data-mode="normal" onclick="setMode('normal')">Normal</button>
            <button class="mode-btn" data-mode="aggressive" onclick="setMode('aggressive')">Aggressive</button>
            <div class="divider-v"></div>
            <button class="bypass-btn" id="bypass-btn" onclick="toggleBypass()">Toggle Bypass</button>
          </div>
        </div>
      </div>

      <!-- Rate Limits — moved here, right after controls -->
      <div class="section">
        <div class="section-head"><span class="section-title">Rate Limits</span></div>
        <div class="section-body" id="limits-body">
          <div class="lim-nodata">Loading…</div>
        </div>
      </div>

      <!-- Two-col grid -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <!-- Tools -->
        <div class="section" style="margin:0">
          <div class="section-head"><span class="section-title">Top Tools</span></div>
          <div class="section-body" id="tools-body">
            <div class="sk" style="height:14px;margin-bottom:8px"></div>
            <div class="sk" style="height:14px;margin-bottom:8px;width:80%"></div>
            <div class="sk" style="height:14px;width:65%"></div>
          </div>
        </div>
        <!-- Cache -->
        <div class="section" style="margin:0">
          <div class="section-head"><span class="section-title">Cache</span></div>
          <div class="section-body">
            <div class="cache-row">
              <div class="cache-card"><div class="cache-label">Hits</div><div class="cache-val" id="c-hits">—</div></div>
              <div class="cache-card"><div class="cache-label">Misses</div><div class="cache-val" id="c-miss">—</div></div>
              <div class="cache-card"><div class="cache-label">Rate</div><div class="cache-val" id="c-rate">—</div></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Spend: theoretical vs real -->
      <div class="section">
        <div class="section-head"><span class="section-title">Cost Comparison</span><span style="font-size:11px;color:var(--text3)">est. at $3/1M tokens</span></div>
        <div class="section-body">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
            <div style="text-align:center">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:6px">Without Squeezr</div>
              <div style="font-size:24px;font-weight:700;color:var(--text)" id="sp-without">—</div>
              <div style="font-size:11px;color:var(--text3);margin-top:4px" id="sp-without-tok">—</div>
            </div>
            <div style="text-align:center">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:6px">With Squeezr</div>
              <div style="font-size:24px;font-weight:700;color:var(--brand2)" id="sp-with">—</div>
              <div style="font-size:11px;color:var(--text3);margin-top:4px" id="sp-with-tok">—</div>
            </div>
            <div style="text-align:center">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:6px">Saved</div>
              <div style="font-size:24px;font-weight:700;color:var(--brand2)" id="sp-saved">—</div>
              <div style="font-size:11px;color:var(--text3);margin-top:4px" id="sp-saved-pct">—</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Model breakdown -->
      <div class="section">
        <div class="section-head"><span class="section-title">By model</span><span style="font-size:11px;color:var(--text3)">real pricing per model</span></div>
        <div class="section-body" id="model-body">
          <div style="font-size:13px;color:var(--text3)">No model data yet.</div>
        </div>
      </div>

      <!-- Savings by client -->
      <div class="section">
        <div class="section-head"><span class="section-title">Savings by client</span></div>
        <div class="section-body" id="client-body-overview">
          <div style="font-size:13px;color:var(--text3)">No data yet — starts after first request.</div>
        </div>
      </div>
    </div>

    <!-- ── Savings page ── -->
    <div id="page-savings" style="display:none">

      <!-- Period selector -->
      <div style="display:flex;gap:8px;margin-bottom:20px;align-items:center">
        <span style="font-size:13px;color:var(--text2);font-weight:500">Period:</span>
        <button class="mode-btn active" id="period-day"   onclick="setSavingsPeriod('day')">Today</button>
        <button class="mode-btn"        id="period-week"  onclick="setSavingsPeriod('week')">7 days</button>
        <button class="mode-btn"        id="period-month" onclick="setSavingsPeriod('month')">30 days</button>
        <button class="mode-btn"        id="period-all"   onclick="setSavingsPeriod('all')">All time</button>
      </div>

      <!-- Period hero -->
      <div class="hero-grid" id="savings-hero">
        <div class="hero-card accent">
          <div class="hc-label">Tokens Saved</div>
          <div class="hc-val" id="sv-tokens">—</div>
          <div class="hc-sub" id="sv-tokens-sub">—</div>
        </div>
        <div class="hero-card">
          <div class="hc-label">Est. Cost Saved</div>
          <div class="hc-val" id="sv-cost">—</div>
          <div class="hc-sub">at $3/1M tokens</div>
        </div>
        <div class="hero-card">
          <div class="hc-label">Sessions</div>
          <div class="hc-val" id="sv-sessions">—</div>
          <div class="hc-sub" id="sv-requests">—</div>
        </div>
        <div class="hero-card">
          <div class="hc-label">Avg Saving</div>
          <div class="hc-val" id="sv-pct">—</div>
          <div class="hc-sub">per session</div>
        </div>
      </div>

      <!-- Daily breakdown chart (bar chart) -->
      <div class="section">
        <div class="section-head"><span class="section-title" id="savings-chart-title">Daily breakdown</span></div>
        <div class="section-body" id="savings-chart">
          <div class="sk" style="height:80px"></div>
        </div>
      </div>

      <!-- By model -->
      <div class="section">
        <div class="section-head"><span class="section-title">By model</span><span style="font-size:11px;color:var(--text3)">real pricing per model</span></div>
        <div class="section-body" id="model-body-savings">
          <div style="font-size:13px;color:var(--text3)">No model data yet.</div>
        </div>
      </div>

      <!-- By client -->
      <div class="section">
        <div class="section-head"><span class="section-title">By client (current session)</span></div>
        <div class="section-body" id="client-body-savings">
          <div style="font-size:13px;color:var(--text3)">No client data yet.</div>
        </div>
      </div>
    </div>

    <!-- ── Settings page ── -->
    <div id="page-settings" style="display:none">

      <div id="update-banner" style="display:none;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);border-radius:12px;padding:14px 20px;margin-bottom:20px;align-items:center;justify-content:space-between">
        <div>
          <span style="color:#fbbf24;font-weight:600;font-size:13px">Update available</span>
          <span id="update-text" style="color:var(--text2);font-size:13px;margin-left:8px"></span>
        </div>
        <button class="action-btn" onclick="runAction('update')" style="border-color:rgba(251,191,36,.4);color:#fbbf24">Update now</button>
      </div>


      <div class="settings-block">
        <div class="settings-head">Proxy endpoints</div>
        <div class="settings-row">
          <span class="s-key" title="Claude Code, Claude Desktop, Aider, OpenCode">Anthropic <span style="font-size:11px;color:var(--text3)">(Claude)</span></span>
          <span class="s-val"><code id="cfg-url-val">—</code></span>
        </div>
        <div class="settings-row">
          <span class="s-key" title="Codex Desktop app, Continue, Cline, Cursor — use openai_base_url">Codex Desktop <span style="font-size:11px;color:var(--text3)">/ OpenAI apps</span></span>
          <span class="s-val"><code id="cfg-oai-val">—</code><span style="font-size:11px;color:var(--text3);margin-left:6px">/v1 · openai_base_url</span></span>
        </div>
        <div class="settings-row">
          <span class="s-key" title="Gemini CLI — GEMINI_API_BASE_URL">Gemini CLI</span>
          <span class="s-val"><code id="cfg-gem-val">—</code><span style="font-size:11px;color:var(--text3);margin-left:6px">GEMINI_API_BASE_URL</span></span>
        </div>
        <div class="settings-row">
          <span class="s-key" title="Codex CLI (terminal) — WebSocket TLS intercept, set HTTPS_PROXY per session">Codex CLI <span style="font-size:11px;color:var(--text3)">(terminal)</span></span>
          <span class="s-val"><code id="cfg-mitm-val">—</code><span style="font-size:11px;color:var(--text3);margin-left:6px">HTTPS_PROXY · TLS intercept</span></span>
        </div>
        <div class="settings-row">
          <span class="s-key">Version</span>
          <span class="s-val" id="cfg-ver">—</span>
        </div>
        <div class="settings-row">
          <span class="s-key">Uptime</span>
          <span class="s-val" id="cfg-uptime" style="color:var(--brand2)">—</span>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-head">Compression</div>
        <div class="settings-row">
          <span class="s-key">Mode</span>
          <span class="s-val"><code id="cfg-mode">—</code></span>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:4px">
          <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
            <span class="s-key">Bypass</span>
            <span class="s-val"><code id="cfg-bypass">—</code></span>
          </div>
          <div style="font-size:12px;color:var(--text3);line-height:1.4">
            When <strong style="color:var(--text2)">enabled</strong>, all requests pass through to the API <em>without compression</em> — useful to check if Squeezr is causing any issue. Stats are still logged. Resets automatically when the proxy restarts.
          </div>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:4px">
          <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
            <span class="s-key">Circuit Breaker</span>
            <span class="s-val"><code id="cfg-cb">—</code></span>
          </div>
          <div style="font-size:12px;color:var(--text3);line-height:1.4">
            Protects against latency spikes. If the local AI compression model (Ollama) fails <strong style="color:var(--text2)">3 times in a row</strong>, it auto-disables AI compression and falls back to deterministic rules only. Returns to normal after 60s without errors. Deterministic compression always stays active.
          </div>
        </div>
      </div>

      <!-- Token savings by client — toggle -->
      <div class="settings-block">
        <div class="settings-head" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between" onclick="toggleClientBreakdown()">
          <span>Token savings by client</span>
          <svg id="cli-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="transition:transform .2s;color:var(--text3)">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div id="cli-breakdown" style="display:none">
          <div id="cli-breakdown-body" style="padding:14px 20px">
            <span style="font-size:13px;color:var(--text3)">No client data yet — starts tracking after first request.</span>
          </div>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-head">Connected CLIs &amp; Apps</div>
        <div class="chips">
          <div class="chip"><div class="chip-dot"></div>Claude Code</div>
          <div class="chip"><div class="chip-dot"></div>Claude Desktop</div>
          <div class="chip"><div class="chip-dot"></div>Codex Desktop</div>
          <div class="chip"><div class="chip-dot"></div>Codex CLI</div>
          <div class="chip"><div class="chip-dot"></div>Aider</div>
          <div class="chip"><div class="chip-dot"></div>Gemini CLI</div>
          <div class="chip"><div class="chip-dot"></div>Cursor</div>
          <div class="chip"><div class="chip-dot"></div>Continue.dev</div>
          <div class="chip"><div class="chip-dot"></div>Windsurf</div>
          <div class="chip"><div class="chip-dot"></div>Cline</div>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-head">Actions</div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <span class="s-key">Status</span>
            <button class="action-btn" onclick="runAction('status')">Check Status</button>
          </div>
          <div class="action-result" id="action-result-status"></div>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <span class="s-key">Stop Proxy</span>
            <button class="action-btn danger" onclick="runAction('stop')">Stop Proxy</button>
          </div>
          <div class="action-result" id="action-result-stop"></div>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <span class="s-key">Update Squeezr</span>
            <button class="action-btn" onclick="runAction('update')">Update to latest</button>
          </div>
          <div class="action-result" id="action-result-update"></div>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:12px">
            <span class="s-key" style="flex-shrink:0">Ports</span>
            <div style="display:flex;align-items:center;gap:8px;flex:1;justify-content:flex-end">
                <input id="inp-http-port" type="number" placeholder="HTTP" style="width:80px;padding:5px 10px;border-radius:7px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:12px;font-family:inherit">
              <input id="inp-mitm-port" type="number" placeholder="MITM" style="width:80px;padding:5px 10px;border-radius:7px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:12px;font-family:inherit">
              <button class="action-btn" onclick="runAction('ports')">Apply</button>
            </div>
          </div>
          <div class="action-result" id="action-result-ports"></div>
        </div>
      </div>
    </div>

  </main>
</div>

<script>
// ── Theme ──────────────────────────────────────────────────────────────────
var MOON = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
var SUN  = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';

(function(){
  var t = localStorage.getItem('sq-theme') || 'dark';
  setTheme(t, false);
})();

function setTheme(t, save) {
  if (t === 'dark') {
    document.documentElement.classList.add('dark');
    document.getElementById('theme-icon').innerHTML = MOON;
    document.querySelector('.theme-label') && (document.querySelector('.theme-label').textContent = 'Light mode');
  } else {
    document.documentElement.classList.remove('dark');
    document.getElementById('theme-icon').innerHTML = SUN;
    document.querySelector('.theme-label') && (document.querySelector('.theme-label').textContent = 'Dark mode');
  }
  if (save !== false) localStorage.setItem('sq-theme', t);
}

function toggleTheme() {
  var isDark = document.documentElement.classList.contains('dark');
  setTheme(isDark ? 'light' : 'dark');
}

// ── Navigation ─────────────────────────────────────────────────────────────
function go(page) {
  document.querySelectorAll('.nb-tab').forEach(function(el) {
    el.classList.toggle('active', el.dataset.page === page);
  });
  document.getElementById('page-overview').style.display = page === 'overview' ? '' : 'none';
  document.getElementById('page-savings').style.display  = page === 'savings'  ? '' : 'none';
  document.getElementById('page-settings').style.display = page === 'settings' ? '' : 'none';
  if (page === 'savings') loadSavings();
  try { localStorage.setItem('sq-page', page); } catch(e) {}
}

// Restore last tab on load
(function(){
  var saved = localStorage.getItem('sq-page');
  if (saved && saved !== 'overview') go(saved);
})();

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtUsd(n) {
  if (n == null || isNaN(n) || n === 0) return '—';
  if (n < 0.01) return '<$0.01';
  return '$' + Number(n).toFixed(2);
}
function fmtRatio(r) {
  if (r == null) return '—';
  return Math.round((1 - r) * 100) + '%';
}
function fmtUptime(s) {
  if (s == null) return '—';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Render ─────────────────────────────────────────────────────────────────
var lastStats = null;

function render(d) {
  if (!d) return;
  lastStats = d;

  // ── Normalize field names (API uses snake_case with various naming conventions) ──
  // tokens — server uses CHARS_PER_TOKEN=3.5, match it here for consistency
  var tokensSaved = d.total_saved_tokens || d.tokens_saved || 0;
  var tokensIn    = Math.round((d.total_original_chars || 0) / 3.5); // same ratio as stats.ts
  // ratio: API gives savings_pct (0-100), or compression_ratio (0-1)
  var ratioPct    = d.savings_pct != null ? d.savings_pct
                  : d.compression_ratio != null ? Math.round((1 - d.compression_ratio) * 100)
                  : null;
  // cost estimate: if not provided, estimate from saved tokens at ~$3/1M tokens
  var costUsd     = d.cost_saved_usd != null ? d.cost_saved_usd
                  : tokensSaved > 0 ? tokensSaved * 0.000003 : null;
  // requests
  var reqs        = d.requests != null ? d.requests : (d.total_requests || 0);
  var comps       = d.compressions != null ? d.compressions : (d.compressed || 0);
  // latency: nested object { total: { p50, p95, p99 } } or flat
  var lat         = (d.latency && d.latency.total) ? d.latency.total : d.latency || {};
  var p50         = lat.p50 != null ? lat.p50 : d.latency_p50;
  var p95         = lat.p95 != null ? lat.p95 : d.latency_p95;
  var p99         = lat.p99 != null ? lat.p99 : d.latency_p99;
  // cache: nested { hits, misses } or flat
  var cacheHits   = (d.cache && d.cache.hits != null) ? d.cache.hits : (d.cache_hits || 0);
  var cacheMiss   = (d.cache && d.cache.misses != null) ? d.cache.misses : (d.cache_miss || 0);
  // bypass
  var byp         = !!(d.bypassed || d.bypass);
  var mode        = d.mode || 'normal';

  // Sidebar version
  if (d.version) document.getElementById('sb-ver').textContent = 'v' + d.version;

  // Hero cards
  document.getElementById('h-saved').textContent = fmt(tokensSaved);
  document.getElementById('h-in').textContent    = fmt(tokensIn);
  document.getElementById('h-ratio').textContent = ratioPct != null ? Math.round(ratioPct) + '%' : '—';
  document.getElementById('h-cost').textContent  = fmtUsd(costUsd);
  document.getElementById('h-reqs').textContent  = fmt(reqs);
  document.getElementById('h-comp').textContent  = fmt(comps);

  // Latency (elements removed from Overview but kept for potential future use)
  var lp = function(id, v){ var e = document.getElementById(id); if(e) e.textContent = v != null ? v : '—'; };
  lp('l-50', p50); lp('l-95', p95); lp('l-99', p99);

  // Cache
  var tot = cacheHits + cacheMiss;
  document.getElementById('c-hits').textContent = fmt(cacheHits);
  document.getElementById('c-miss').textContent = fmt(cacheMiss);
  document.getElementById('c-rate').textContent = tot > 0 ? Math.round(cacheHits/tot*100) + '%' : '—';

  // Tools
  renderTools(d.by_tool || d.tools);

  // Limits
  renderLimits(d.limits);

  // Cost comparison (#7) — weighted by actual models used
  var modelCosts = calcCostFromModels(d.by_model, true);
  var actualTokens = tokensIn - tokensSaved;
  var costSaved, costWithout, costWith, priceNote;
  if (modelCosts && modelCosts.totalCost > 0) {
    // Precise: model-weighted pricing
    costSaved   = modelCosts.savedCost;
    costWithout = modelCosts.totalCost;
    costWith    = modelCosts.totalCost - modelCosts.savedCost;
    priceNote   = 'model-weighted pricing';
  } else {
    // Fallback: flat $3/1M
    var flat = 0.000003;
    costSaved   = tokensSaved * flat;
    costWithout = tokensIn * flat;
    costWith    = actualTokens * flat;
    priceNote   = 'est. $3/1M (no model data)';
  }
  var setTxt = function(id, v){ var e = document.getElementById(id); if(e) e.textContent = v; };
  setTxt('sp-without',     costWithout > 0 ? fmtUsd(costWithout) : '—');
  setTxt('sp-without-tok', tokensIn > 0 ? '~' + fmt(tokensIn) + ' tokens' : '—');
  setTxt('sp-with',        costWith > 0 ? fmtUsd(costWith) : '—');
  setTxt('sp-with-tok',    actualTokens > 0 ? '~' + fmt(actualTokens) + ' tokens' : '—');
  setTxt('sp-saved',       costSaved > 0 ? fmtUsd(costSaved) : '—');
  setTxt('sp-saved-pct',   (ratioPct != null ? Math.round(ratioPct) + '% · ' : '') + priceNote);
  // Model breakdown section
  renderModelBreakdown(d.by_model);

  // CLI breakdown (#8)
  renderClientBreakdown(d.by_client);

  // Mode & bypass
  updateMode(mode, byp);

  // Settings page — ports come from health endpoint (d.port / d.mitm_port)
  var httpPort = d.port || window.location.port || '8080';
  var mitmPort = d.mitm_port || (parseInt(String(httpPort)) + 1);
  var setEl = function(id, v){ var e = document.getElementById(id); if(e) e.textContent = v; };
  setEl('cfg-url-val', 'http://localhost:' + httpPort);
  setEl('cfg-oai-val', 'http://localhost:' + httpPort + '/v1');
  setEl('cfg-gem-val', 'http://localhost:' + httpPort);
  setEl('cfg-mitm-val', 'http://localhost:' + mitmPort);
  var ih = document.getElementById('inp-http-port'); if(ih && !ih.value) ih.value = String(httpPort);
  var im = document.getElementById('inp-mitm-port'); if(im && !im.value) im.value = String(mitmPort);
  if (d.version) document.getElementById('cfg-ver').textContent = d.version;
  if (d.uptime_seconds != null) document.getElementById('cfg-uptime').textContent = fmtUptime(d.uptime_seconds);
  document.getElementById('cfg-mode').textContent   = mode;
  document.getElementById('cfg-bypass').textContent = byp ? 'enabled' : 'disabled';
  if (d.circuit_breaker) {
    var cb = d.circuit_breaker;
    document.getElementById('cfg-cb').textContent = cb.state + (cb.total_trips ? ' · ' + cb.total_trips + ' trips' : '');
  }
}

function renderTools(tools) {
  var el = document.getElementById('tools-body');
  if (!tools || typeof tools !== 'object') {
    el.innerHTML = '<span style="font-size:13px;color:var(--text3)">No tool data yet</span>';
    return;
  }
  // tools can be { ToolName: count } or { ToolName: { count, saved_tokens } }
  var entries = Object.entries(tools)
    .map(function(e){ return [e[0], typeof e[1] === 'object' ? e[1].count || 0 : e[1]]; })
    .filter(function(e){ return e[1] > 0; })
    .sort(function(a,b){ return b[1]-a[1]; })
    .slice(0,6);
  if (!entries.length) {
    el.innerHTML = '<span style="font-size:13px;color:var(--text3)">No tools recorded yet</span>';
    return;
  }
  var max = entries[0][1];
  el.innerHTML = entries.map(function(e){
    var pct = max > 0 ? Math.round(e[1]/max*100) : 0;
    return '<div class="tool-row"><span class="tool-name">'+esc(e[0])+'</span>'+
      '<div class="tool-track"><div class="tool-fill" style="width:'+pct+'%"></div></div>'+
      '<span class="tool-count">'+fmt(e[1])+'</span></div>';
  }).join('');
}

function renderLimits(lim) {
  var el = document.getElementById('limits-body');
  if (!lim || typeof lim !== 'object') {
    el.innerHTML = '<div class="lim-nodata">No limit data yet.</div>';
    return;
  }
  var claudeRows = [];
  var openaiRows = [];
  var rows = claudeRows; // default alias for Claude section

  // ── Claude / Anthropic ──────────────────────────────────────────────────
  var a = lim.anthropic;
  if (a) {
    // unified = Claude Code Max / subscription plan rate limits
    var u = a.unified;
    if (u && u.hasData) {
      var p5 = Math.round(u.fiveHourUtilization * 100);
      var p7 = Math.round(u.sevenDayUtilization * 100);
      var c5 = p5 > 90 ? 'crit' : p5 > 70 ? 'warn' : 'ok';
      var c7 = p7 > 90 ? 'crit' : p7 > 70 ? 'warn' : 'ok';
      var reset5 = u.fiveHourResetEpoch ? new Date(u.fiveHourResetEpoch).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
      var reset7 = u.sevenDayResetEpoch ? new Date(u.sevenDayResetEpoch).toLocaleDateString([], {month:'short',day:'numeric'}) : '';
      rows.push(limRow('Claude 5h window', p5, c5, p5 + '% used' + (reset5 ? ' · resets ' + reset5 : '')));
      rows.push(limRow('Claude 7d window', p7, c7, p7 + '% used' + (reset7 ? ' · resets ' + reset7 : '')));
    }
    // rl = standard API rate limit headers (available with API key, not subscription)
    var rl = a.rl;
    if (rl && rl.hasData) {
      if (rl.tokensLimit > 0) {
        var used = rl.tokensLimit - rl.tokensRemaining;
        var pp = Math.round(used / rl.tokensLimit * 100);
        rows.push(limRow('Claude tokens/min', pp, pp > 90 ? 'crit' : pp > 70 ? 'warn' : 'ok',
          fmt(used) + ' / ' + fmt(rl.tokensLimit)));
      }
      if (rl.requestsLimit > 0) {
        var usedR = rl.requestsLimit - rl.requestsRemaining;
        var ppR = Math.round(usedR / rl.requestsLimit * 100);
        rows.push(limRow('Claude req/min', ppR, ppR > 90 ? 'crit' : ppR > 70 ? 'warn' : 'ok',
          usedR + ' / ' + rl.requestsLimit));
      }
    }
    // usage — actual tokens sent to Anthropic this session
    if (a.usage && (a.usage.inputSession || a.usage.outputSession)) {
      rows.push('<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<div style="font-size:11px;color:var(--text3);margin-bottom:4px">Actual API tokens this session</div>' +
        '<div style="font-size:13px;color:var(--text2)">' +
          'In: <strong style="color:var(--text)">' + fmt(a.usage.inputSession) + '</strong>&ensp;' +
          'Out: <strong style="color:var(--text)">' + fmt(a.usage.outputSession) + '</strong>' +
        '</div></div>');
    }
  }

  // ── OpenAI / Codex ──────────────────────────────────────────────────────
  rows = openaiRows; // switch alias
  var o = lim.openai;
  if (o) {
    var os = o.session;
    if (os && os.hasData && os.primary) {
      var pp2 = os.primary.usedPercent || 0;
      var c2 = pp2 > 90 ? 'crit' : pp2 > 70 ? 'warn' : 'ok';
      var resetTs = os.primary.resetsAt ? new Date(os.primary.resetsAt * 1000).toLocaleDateString([],{month:'short',day:'numeric'}) : '';
      rows.push(limRow('Codex ' + (os.primary.windowDurationMins >= 10080 ? '7d' : os.primary.windowDurationMins + 'min'),
        pp2, c2, pp2 + '% used' + (resetTs ? ' · resets ' + resetTs : '')));
    }
    if (o.usage && o.usage.inputSession) {
      rows.push('<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<div style="font-size:11px;color:var(--text3);margin-bottom:4px">Codex tokens this session</div>' +
        '<div style="font-size:13px;color:var(--text2)">' +
          'In: <strong style="color:var(--text)">' + fmt(o.usage.inputSession) + '</strong>&ensp;' +
          'Out: <strong style="color:var(--text)">' + fmt(o.usage.outputSession) + '</strong>' +
        '</div></div>');
    }
  }

  if (!claudeRows.length && !openaiRows.length) {
    el.innerHTML = '<div class="lim-nodata">No limit data yet — appears after first API call.</div>';
    return;
  }

  var col = function(title, content) {
    return '<div>' +
      '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:10px">' + title + '</div>' +
      (content || '<div class="lim-nodata" style="padding:0">No data</div>') +
    '</div>';
  };

  el.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">' +
    col('Claude', claudeRows.length ? '<div class="limits-grid">' + claudeRows.join('') + '</div>' : null) +
    col('Codex / OpenAI', openaiRows.length ? '<div class="limits-grid">' + openaiRows.join('') + '</div>' : null) +
  '</div>';
}

function limRow(name, pct, cls, label) {
  return '<div class="lim-row">'+
    '<span class="lim-name">'+esc(name)+'</span>'+
    '<div class="lim-track"><div class="lim-fill '+cls+'" style="width:'+pct+'%"></div></div>'+
    '<span class="lim-text">'+esc(label)+'</span></div>';
}

// ── Pricing table ($/1M tokens) ───────────────────────────────────────────
var PRICING = {
  // ── Claude ──
  'claude-opus-4':            { input: 15,   output: 75   },
  'claude-opus-4-5':          { input: 15,   output: 75   },
  'claude-opus-3':            { input: 15,   output: 75   },
  'claude-sonnet-4':          { input: 3,    output: 15   },
  'claude-sonnet-4-5':        { input: 3,    output: 15   },
  'claude-3-7-sonnet':        { input: 3,    output: 15   },
  'claude-3-5-sonnet':        { input: 3,    output: 15   },
  'claude-3-sonnet':          { input: 3,    output: 15   },
  'claude-haiku-3-5':         { input: 0.8,  output: 4    },
  'claude-3-5-haiku':         { input: 0.8,  output: 4    },
  'claude-3-haiku':           { input: 0.25, output: 1.25 },
  // ── OpenAI ──
  'gpt-4o':                   { input: 2.5,  output: 10   },
  'gpt-4o-mini':              { input: 0.15, output: 0.6  },
  'gpt-4-turbo':              { input: 10,   output: 30   },
  'gpt-4':                    { input: 30,   output: 60   },
  'o1':                       { input: 15,   output: 60   },
  'o1-mini':                  { input: 3,    output: 12   },
  'o1-pro':                   { input: 150,  output: 600  },
  'o3':                       { input: 10,   output: 40   },
  'o3-mini':                  { input: 1.1,  output: 4.4  },
  'o4-mini':                  { input: 1.1,  output: 4.4  },
  'codex-mini-latest':        { input: 1.5,  output: 6    },
  // ── Gemini ──
  'gemini-2.5-pro':           { input: 1.25, output: 10   },
  'gemini-2.5-flash':         { input: 0.075,output: 0.3  },
  'gemini-2.0-flash':         { input: 0.1,  output: 0.4  },
  'gemini-2.0-flash-lite':    { input: 0.075,output: 0.3  },
  'gemini-1.5-pro':           { input: 1.25, output: 5    },
  'gemini-1.5-flash':         { input: 0.075,output: 0.3  },
};
var DEFAULT_PRICE_INPUT = 3; // Claude Sonnet fallback

function getModelPrice(model) {
  if (!model) return DEFAULT_PRICE_INPUT;
  var m = model.toLowerCase();
  // exact match first
  if (PRICING[m]) return PRICING[m].input;
  // prefix match (handles date-stamped variants like claude-sonnet-4-5-20251101)
  for (var key in PRICING) {
    if (m.startsWith(key) || m.includes(key)) return PRICING[key].input;
  }
  return DEFAULT_PRICE_INPUT;
}

function calcCostFromModels(byModel, getOriginal) {
  // If we have per-model breakdown, weight by actual model price
  if (!byModel || !Object.keys(byModel).length) return null;
  var totalCost = 0;
  var savedCost = 0;
  for (var model in byModel) {
    var data = byModel[model];
    var price = getModelPrice(model) / 1000000; // $/token
    var origTok = getOriginal ? data.original_tokens : 0;
    var savedTok = data.saved_tokens || 0;
    totalCost += origTok * price;
    savedCost += savedTok * price;
  }
  return { totalCost: totalCost, savedCost: savedCost };
}

// ── Model breakdown ────────────────────────────────────────────────────────
function renderModelBreakdown(byModel) {
  var el = document.getElementById('model-body');
  var elSav = document.getElementById('model-body-savings');
  var noData = '<span style="font-size:13px;color:var(--text3)">No model data yet — appears after first request.</span>';
  if (!byModel || !Object.keys(byModel).length) {
    if (el) el.innerHTML = noData;
    if (elSav) elSav.innerHTML = noData;
    return;
  }
  var rows = Object.entries(byModel)
    .filter(function(e){ return e[1].requests > 0; })
    .sort(function(a,b){ return b[1].saved_tokens - a[1].saved_tokens; });
  if (!rows.length) { if (el) el.innerHTML = noData; if (elSav) elSav.innerHTML = noData; return; }

  var maxSaved = rows[0][1].saved_tokens || 1;
  var html = rows.map(function(e){
    var model = e[0];
    var data  = e[1];
    var priceIn = getModelPrice(model);
    var savedCost = data.saved_tokens * priceIn / 1000000;
    var origCost  = data.original_tokens * priceIn / 1000000;
    var pct = Math.round((data.saved_tokens / maxSaved) * 100);
    var priceLabel = priceIn === DEFAULT_PRICE_INPUT ? '$' + priceIn + '/1M (est.)' : '$' + priceIn + '/1M input';
    return '<div style="margin-bottom:14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">' +
        '<span style="font-size:13px;font-weight:600;color:var(--text);font-family:\'Cascadia Code\',monospace">' + esc(model) + '</span>' +
        '<span style="font-size:12px;color:var(--text3)">' + priceLabel + '</span>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">' +
        '<span style="font-size:12px;color:var(--text2)">' + fmt(data.saved_tokens) + ' tokens saved · ' + data.savings_pct + '%</span>' +
        '<span style="font-size:12px;color:var(--brand2);font-weight:600">' + fmtUsd(savedCost) + ' saved</span>' +
      '</div>' +
      '<div style="height:6px;background:var(--surface3);border-radius:3px;overflow:hidden;margin-bottom:3px">' +
        '<div style="height:100%;width:' + pct + '%;background:var(--brand);border-radius:3px;transition:width .4s"></div>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text3)">' +
        data.requests + ' req · without Squeezr: ' + fmtUsd(origCost) + ' · with: ' + fmtUsd(origCost - savedCost) +
      '</div>' +
    '</div>';
  }).join('');
  if (el) el.innerHTML = html;
  if (elSav) elSav.innerHTML = html;
}

// ── Client breakdown (#8) ──────────────────────────────────────────────────
var clientOpen = false;
var CLIENT_LABELS = {
  claude_code:    'Claude Code',
  claude_desktop: 'Claude Desktop',
  aider:          'Aider',
  opencode:       'OpenCode',
  codex_desktop:  'Codex Desktop',
  cursor:         'Cursor',
  continue:       'Continue.dev',
  cline:          'Cline / Roo',
  windsurf:       'Windsurf',
  openai_other:   'OpenAI (other)',
  gemini:         'Gemini CLI',
  mitm:           'Codex CLI',
};

function toggleClientBreakdown() {
  clientOpen = !clientOpen;
  document.getElementById('cli-breakdown').style.display = clientOpen ? '' : 'none';
  document.getElementById('cli-chevron').style.transform = clientOpen ? 'rotate(180deg)' : '';
}

function renderClientBreakdown(byClient) {
  var noData = '<span style="font-size:13px;color:var(--text3)">No client data yet — starts after first request.</span>';
  var elOverview  = document.getElementById('client-body-overview');
  var elSettings  = document.getElementById('cli-breakdown-body');

  if (!byClient || !Object.keys(byClient).length) {
    if (elOverview) elOverview.innerHTML = noData;
    if (elSettings) elSettings.innerHTML = noData;
    return;
  }
  var rows = Object.entries(byClient)
    .filter(function(e){ return e[1].requests > 0; })
    .sort(function(a,b){ return b[1].saved_tokens - a[1].saved_tokens; });
  if (!rows.length) {
    if (elOverview) elOverview.innerHTML = noData;
    if (elSettings) elSettings.innerHTML = noData;
    return;
  }
  var maxSaved = rows[0][1].saved_tokens || 1;
  var html = rows.map(function(e){
    var label = CLIENT_LABELS[e[0]] || e[0];
    var data  = e[1];
    var pct   = Math.round((data.saved_tokens / maxSaved) * 100);
    return '<div style="margin-bottom:12px">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">' +
        '<span style="font-size:13px;font-weight:600;color:var(--text)">' + esc(label) + '</span>' +
        '<span style="font-size:12px;color:var(--brand2);font-weight:600">' + fmt(data.saved_tokens) + ' saved&nbsp;<span style="color:var(--text3);font-weight:400">·&nbsp;' + data.savings_pct + '%</span></span>' +
      '</div>' +
      '<div style="height:6px;background:var(--surface3);border-radius:3px;overflow:hidden;margin-bottom:3px">' +
        '<div style="height:100%;width:' + pct + '%;background:var(--brand);border-radius:3px;transition:width .4s"></div>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text3)">' + data.requests + ' req · ~' + fmt(data.original_tokens) + ' tokens in</div>' +
    '</div>';
  }).join('');
  if (elOverview) elOverview.innerHTML = html;
  if (elSettings) elSettings.innerHTML = html;
}

function updateMode(mode, byp) {
  var mb = document.getElementById('mode-badge');
  mb.textContent = 'mode: ' + mode;
  mb.className = 'badge' + (mode === 'off' ? ' red' : ' green');

  var bb = document.getElementById('bypass-badge');
  bb.textContent = byp ? 'bypass: on' : 'bypass: off';
  bb.className = 'badge' + (byp ? ' yellow' : '');

  document.querySelectorAll('.mode-btn').forEach(function(btn) {
    btn.className = 'mode-btn' + (btn.dataset.mode === mode ? (mode === 'off' ? ' active-off' : ' active') : '');
  });
  document.getElementById('bypass-btn').className = 'bypass-btn' + (byp ? ' active' : '');
}

// ── Controls ───────────────────────────────────────────────────────────────
function setMode(mode) {
  fetch('/squeezr/config', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({mode: mode})
  }).then(function(r){
    if (r.ok && lastStats) { lastStats.mode = mode; updateMode(mode, !!(lastStats.bypass || lastStats.bypassed)); }
  });
}

function toggleBypass() {
  fetch('/squeezr/bypass', {method:'POST'}).then(function(r){ if(r.ok) poll(); });
}

// ── Connection ─────────────────────────────────────────────────────────────
var pollTimer = null, sseOk = false;

function poll() {
  fetch('/squeezr/stats').then(function(r){ return r.json(); }).then(render).catch(function(){});
}

function setConn(ok) {
  document.getElementById('conn-dot').className = 'conn-dot ' + (ok ? 'online' : 'offline');
  document.getElementById('conn-label').textContent = ok ? 'Connected' : 'Offline';
}

function startPoll() {
  if (!pollTimer) { pollTimer = setInterval(poll, 5000); poll(); }
}

function connect() {
  var es;
  try { es = new EventSource('/squeezr/events'); }
  catch(e) { setConn(false); startPoll(); return; }

  var timer = setTimeout(function(){ if (!sseOk){ es.close(); setConn(false); startPoll(); } }, 6000);

  es.onopen = function(){ clearTimeout(timer); sseOk = true; setConn(true); clearInterval(pollTimer); pollTimer = null; };
  es.onmessage = function(ev){
    clearTimeout(timer);
    if (!sseOk){ sseOk = true; setConn(true); clearInterval(pollTimer); pollTimer = null; }
    try { render(JSON.parse(ev.data)); } catch(e){}
  };
  es.addEventListener('stats', function(ev){ try { render(JSON.parse(ev.data)); } catch(e){} });
  es.onerror = function(){
    clearTimeout(timer); sseOk = false; es.close(); setConn(false); startPoll();
    setTimeout(connect, 10000);
  };
}

// ── Actions ────────────────────────────────────────────────────────────────
function showResult(id, cls, msg) {
  var el = document.getElementById('action-result-' + id);
  if (!el) return;
  el.className = 'action-result ' + cls;
  el.textContent = msg;
  el.style.display = 'block';
}

function runAction(action) {
  if (action === 'status') {
    fetch('/squeezr/health').then(function(r) { return r.json(); }).then(function(h) {
      var msg = 'version: ' + (h.version || '?');
      if (h.uptime != null) msg += '  |  uptime: ' + fmtUptime(h.uptime);
      if (h.mode) msg += '  |  mode: ' + h.mode;
      showResult('status', 'ok', msg);
    }).catch(function(e) {
      showResult('status', 'err', 'Error: ' + e.message);
    });
  } else if (action === 'stop') {
    fetch('/squeezr/control/stop', {method:'POST'}).then(function(r) {
      if (r.ok) {
        showResult('stop', 'ok', 'Proxy stopped');
      } else {
        showResult('stop', 'err', 'Run in terminal: squeezr stop');
      }
    }).catch(function() {
      showResult('stop', 'err', 'Run in terminal: squeezr stop');
    });
  } else if (action === 'update') {
    showResult('update', 'ok', 'Run in terminal: squeezr update');
  } else if (action === 'ports') {
    var httpVal = document.getElementById('inp-http-port').value.trim();
    var mitmVal = document.getElementById('inp-mitm-port').value.trim();
    var httpN = parseInt(httpVal);
    var mitmN = parseInt(mitmVal);
    if (!httpN || httpN < 1024 || httpN > 65535 || !mitmN || mitmN < 1024 || mitmN > 65535) {
      showResult('ports', 'err', 'Invalid ports — must be between 1024 and 65535');
      return;
    }
    if (httpN === mitmN) {
      showResult('ports', 'err', 'HTTP and MITM ports must be different');
      return;
    }
    fetch('/squeezr/ports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: httpN, mitm_port: mitmN })
    }).then(function(r) {
      if (r.ok) {
        showResult('ports', 'ok', 'Ports saved to squeezr.toml — restart Squeezr to apply (squeezr stop && squeezr start)');
      } else {
        r.text().then(function(t) { showResult('ports', 'err', 'Failed: ' + t); });
      }
    }).catch(function(e) { showResult('ports', 'err', e.message); });
  }
}

// ── Version check ──────────────────────────────────────────────────────────
function checkLatestVersion() {
  fetch('/squeezr/health').then(function(r) { return r.json(); }).then(function(h) {
    var current = h.version;
    fetch('https://registry.npmjs.org/squeezr-ai/latest')
      .then(function(r) { return r.json(); }).then(function(npm) {
        var latest = npm.version;
        if (latest && current && latest !== current) {
          var banner = document.getElementById('update-banner');
          document.getElementById('update-text').textContent = 'v' + current + ' → v' + latest;
          banner.style.display = 'flex';
        }
      }).catch(function(){});
  }).catch(function(){});
}

// ── Savings page ──────────────────────────────────────────────────────────
var savingsPeriod = 'day';
var savingsCache = null;

function setSavingsPeriod(p) {
  savingsPeriod = p;
  ['day','week','month','all'].forEach(function(k){
    document.getElementById('period-' + k).className = 'mode-btn' + (k === p ? ' active' : '');
  });
  if (savingsCache) renderSavingsData(savingsCache);
}

function loadSavings() {
  fetch('/squeezr/history').then(function(r){ return r.json(); }).then(function(d){
    savingsCache = d;
    renderSavingsData(d);
  }).catch(function(){
    document.getElementById('savings-chart').innerHTML = '<div class="lim-nodata">Could not load history.</div>';
  });
}

function renderSavingsData(d) {
  var sessions = (d.sessions || []).concat(d.current ? [d.current] : []);
  var now = Date.now();
  var cutoffs = { day: now - 86400000, week: now - 7*86400000, month: now - 30*86400000, all: 0 };
  var cutoff = cutoffs[savingsPeriod] || 0;
  var filtered = sessions.filter(function(s){ return s.startTime >= cutoff && s.savedTokens != null; });

  // Hero stats
  var totalSaved = 0, totalReqs = 0, totalOrig = 0;
  filtered.forEach(function(s){ totalSaved += s.savedTokens||0; totalReqs += s.requests||0; totalOrig += (s.savedTokens||0) + Math.round((s.savedChars||0)/3.5); });
  var avgPct = totalOrig > 0 ? Math.round(totalSaved / (totalSaved + (totalOrig - totalSaved)) * 100) : 0;

  document.getElementById('sv-tokens').textContent    = fmt(totalSaved);
  document.getElementById('sv-tokens-sub').textContent = '~' + fmt(totalOrig) + ' total tokens';
  document.getElementById('sv-cost').textContent      = fmtUsd(totalSaved * 0.000003);
  document.getElementById('sv-sessions').textContent  = String(filtered.length);
  document.getElementById('sv-requests').textContent  = totalReqs + ' requests';
  document.getElementById('sv-pct').textContent       = avgPct > 0 ? avgPct + '%' : '—';

  // Chart title
  var titles = { day: 'Today (by session)', week: 'Last 7 days', month: 'Last 30 days', all: 'All time' };
  document.getElementById('savings-chart-title').textContent = titles[savingsPeriod] || '';

  // Bar chart: group by day for week/month/all, by session for day
  renderSavingsChart(filtered, savingsPeriod);

  // Client breakdown mirrors overview
  var cli = document.getElementById('client-body-savings');
  var ovCli = document.getElementById('client-body-overview');
  if (ovCli) cli.innerHTML = ovCli.innerHTML;
}

function renderSavingsChart(sessions, period) {
  var el = document.getElementById('savings-chart');
  if (!sessions.length) { el.innerHTML = '<div class="lim-nodata">No sessions in this period.</div>'; return; }

  var groups = {};
  sessions.forEach(function(s) {
    var d = new Date(s.startTime);
    var key = period === 'day'
      ? d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
      : d.toLocaleDateString([], {month:'short',day:'numeric'});
    if (!groups[key]) groups[key] = { saved: 0, reqs: 0 };
    groups[key].saved += s.savedTokens || 0;
    groups[key].reqs  += s.requests || 0;
  });

  var entries = Object.entries(groups).slice(-14); // max 14 bars
  var maxVal = Math.max.apply(null, entries.map(function(e){ return e[1].saved; })) || 1;

  el.innerHTML = '<div style="display:flex;align-items:flex-end;gap:6px;height:90px;padding-bottom:2px">' +
    entries.map(function(e){
      var h = Math.max(4, Math.round((e[1].saved / maxVal) * 80));
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0">' +
        '<div style="font-size:9px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;writing-mode:vertical-lr;transform:rotate(180deg);height:28px;line-height:1">' + e[0] + '</div>' +
        '<div title="' + fmt(e[1].saved) + ' tokens saved" style="width:100%;height:' + h + 'px;background:var(--brand);border-radius:3px 3px 0 0;transition:height .3s;cursor:default"></div>' +
      '</div>';
    }).join('') +
  '</div>' +
  '<div style="margin-top:6px;font-size:11px;color:var(--text3)">Hover bars for details · ' + sessions.length + ' sessions · ' + fmt(sessions.reduce(function(a,s){return a+(s.savedTokens||0);},0)) + ' total tokens saved</div>';
}

poll();
connect();
checkLatestVersion();
</script>
</body>
</html>`;
