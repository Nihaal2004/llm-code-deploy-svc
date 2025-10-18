import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import fetch from 'node-fetch';
import mime from 'mime';
const sh = (cmd, opts = {}) =>
  execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- config and helpers ---
function reqEnv(k){ if(!process.env[k]) throw new Error(`Missing ${k}`); return process.env[k]; }
const CFG = {
  user: reqEnv('GITHUB_USERNAME'),
  token: reqEnv('GITHUB_TOKEN'),           // not used by gh, kept for future
  secret: reqEnv('STUDENT_SECRET'),
  port: process.env.PORT || 8080,
  authorName: process.env.GIT_AUTHOR_NAME || 'Task Bot',
  authorEmail: process.env.GIT_AUTHOR_EMAIL || 'bot@example.com',
};

const STATE = path.resolve('./state.json');
if (!fs.existsSync(STATE)) fs.writeFileSync(STATE, JSON.stringify({ tasks:{} }, null, 2));

function sh(cmd, opts={}){ return execSync(cmd, { stdio:'pipe', encoding:'utf8', ...opts }); }
function ensureDir(p){ fs.mkdirSync(p, { recursive:true }); }
function now(){ return new Date().toISOString(); }
function readState(){ return JSON.parse(fs.readFileSync(STATE,'utf8')); }
function writeState(s){ fs.writeFileSync(STATE, JSON.stringify(s,null,2)); }
function safeRepoName(task){
  return (task||'task').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').slice(0,60) + '-' + Date.now().toString(36);
}
function decodeDataUri(uri){
  const m = /^data:([^;]+);base64,(.+)$/i.exec(uri||''); if(!m) throw new Error('Bad data URI');
  return Buffer.from(m[2], 'base64');
}
function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

async function notifyEvaluator(url, payload){
  let delay = 1000;
  for (let i=0;i<6;i++){
    try{
      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      if (r.ok) return true;
    }catch(_) {}
    await new Promise(r=>setTimeout(r, delay));
    delay *= 2;
  }
  return false;
}

// --- template routing ---
function pickTemplate(brief=''){
  const b = brief.toLowerCase();
  if (b.includes('sales summary') || b.includes('sum of sales')) return 'sum-of-sales';
  if (b.includes('markdown') && b.includes('highlight')) return 'markdown-to-html';
  if (b.includes('github-user') || b.includes('account creation date')) return 'github-user-created';
  return 'generic';
}
function extractSeed(brief, tpl){
  if (tpl==='sum-of-sales'){ const m=/Sales Summary ([^"]+)/.exec(brief); if(m) return m[1]; }
  if (tpl==='github-user-created'){ const m=/github-user-([A-Za-z0-9_-]+)/.exec(brief); if(m) return m[1]; }
  return crypto.randomBytes(3).toString('hex');
}

// --- site generator ---
async function generateSite({ workdir, brief, attachments, tpl, seed, round }){
  const site = path.join(workdir, 'site');
  ensureDir(site); ensureDir(path.join(site,'assets'));

  // write attachments
  for (const a of (attachments||[])){
    const buf = decodeDataUri(a.url);
    const name = a.name || ('file.' + (mime.getExtension('application/octet-stream')||'bin'));
    await fsp.writeFile(path.join(site,'assets', name), buf);
  }

  const commonHead = `
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="preconnect" href="https://cdn.jsdelivr.net"/>
<style>body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:20px;max-width:900px;margin:auto}</style>
`.trim();

  const html_sales = `<!doctype html><html><head>
${commonHead}
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<title>Sales Summary ${seed}</title></head><body>
<h1 class="h3 mb-3">Sales Summary ${seed}</h1>
<div class="mb-3">
  <label for="region-filter" class="form-label">Region</label>
  <select id="region-filter" class="form-select"><option value="ALL" selected>ALL</option></select>
</div>
<p>Total: <span id="total-sales" data-region="ALL">0</span> <span id="total-currency">INR</span></p>
<div class="mb-3">
  <label for="currency-picker" class="form-label">Currency</label>
  <select id="currency-picker" class="form-select"><option>INR</option><option>USD</option></select>
</div>
<table id="product-sales" class="table table-sm">
  <thead><tr><th>Product</th><th>Region</th><th class="text-end">Sales</th></tr></thead>
  <tbody></tbody>
</table>
<script>
(async () => {
  const by = new Intl.NumberFormat();
  const params = new URL(location.href).searchParams;
  const csvUrl = params.get('url') || './assets/data.csv';
  let text=''; try{ text = await (await fetch(csvUrl)).text(); }catch(e){}
  const rows = text.trim().split(/\\r?\\n/).map(r=>r.split(/,|\\t/));
  const head = rows.shift()||[];
  const iP=head.findIndex(h=>/product/i.test(h)), iR=head.findIndex(h=>/region/i.test(h)), iS=head.findIndex(h=>/sale/i.test(h));
  const data = rows.map(r=>({p:r[iP]||'?', r:(r[iR]||'ALL'), s: parseFloat(r[iS]||'0')||0}));
  const regions=[...new Set(data.map(d=>d.r))].filter(Boolean);
  const rf=document.querySelector('#region-filter');
  for(const r of regions){ const o=document.createElement('option'); o.value=r; o.textContent=r; rf.appendChild(o); }
  const tbody=document.querySelector('#product-sales tbody');
  async function render(region='ALL'){
    tbody.innerHTML=''; let sum=0;
    for(const d of data){ if(region!=='ALL' && d.r!==region) continue; sum+=d.s;
      const tr=document.createElement('tr'); tr.innerHTML=\`<td>\${d.p}</td><td>\${d.r}</td><td class="text-end">\${by.format(d.s)}</td>\`; tbody.appendChild(tr);
    }
    const cur=document.querySelector('#currency-picker').value;
    let rate=1; try{ const rj=await (await fetch('./assets/rates.json')).json(); if(rj?.rates?.[cur]) rate=rj.rates[cur]; }catch(e){}
    const converted = sum*rate;
    document.querySelector('#total-sales').textContent = by.format(+converted.toFixed(2));
    document.querySelector('#total-sales').dataset.region = region;
    document.querySelector('#total-currency').textContent = cur;
  }
  rf.addEventListener('change', e=>render(e.target.value));
  document.querySelector('#currency-picker').addEventListener('change', ()=>render(rf.value));
  render('ALL');
})();
</script>
</body></html>`;

  const html_md = `<!doctype html><html><head>
${commonHead}
<title>Markdown Viewer</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head><body>
<h1 class="h4">Markdown Viewer</h1>
<div id="markdown-tabs" class="btn-group mb-3" role="tablist">
  <button class="btn btn-outline-primary active" data-tab="rendered">Rendered</button>
  <button class="btn btn-outline-secondary" data-tab="source">Source</button>
</div>
<div id="markdown-source-label" class="text-muted small mb-2"></div>
<div id="markdown-word-count" class="badge bg-secondary mb-3"></div>
<div id="markdown-output"></div>
<pre id="markdown-source" style="display:none;white-space:pre-wrap"></pre>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/common.min.js"></script>
<script>
(async () => {
  const params = new URL(location.href).searchParams;
  const srcUrl = params.get('url') || './assets/input.md';
  document.getElementById('markdown-source-label').textContent = srcUrl;
  const md = await (await fetch(srcUrl)).text();
  const out = document.getElementById('markdown-output');
  const src = document.getElementById('markdown-source');
  src.textContent = md.trim();
  marked.setOptions({highlight:(code,lang)=>{try{return hljs.highlight(code,{language:lang}).value;}catch(e){return code;}}});
  function render(){
    out.innerHTML = marked.parse(src.textContent);
    const wc = src.textContent.trim().split(/\\s+/).filter(Boolean).length;
    document.getElementById('markdown-word-count').textContent = new Intl.NumberFormat().format(wc);
  }
  render();
  document.querySelectorAll('#markdown-tabs button').forEach(btn=>{
    btn.onclick=()=>{ document.querySelectorAll('#markdown-tabs button').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
      const tab=btn.dataset.tab; if(tab==='rendered'){ out.style.display='block'; src.style.display='none'; } else { out.style.display='none'; src.style.display='block'; } };
  });
})();
</script>
</body></html>`;

  const html_gh = `<!doctype html><html><head>
${commonHead}
<title>GitHub User Lookup</title>
</head><body>
<h1 class="h4">GitHub User Created-At</h1>
<div id="github-status" aria-live="polite" class="mb-2"></div>
<form id="github-user-${seed}" class="mb-3">
  <input name="username" class="form-control" placeholder="torvalds" required/>
  <button class="btn btn-primary mt-2">Lookup</button>
</form>
<p>Created at: <span id="github-created-at"></span></p>
<p>Account age: <span id="github-account-age"></span></p>
<script>
(function(){
  const form=document.getElementById('github-user-${seed}');
  const created=document.getElementById('github-created-at');
  const age=document.getElementById('github-account-age');
  const status=document.getElementById('github-status');
  const params=new URL(location.href).searchParams;
  const token=params.get('token');
  const key='github-user-${seed}';
  const cached=localStorage.getItem(key); if(cached){ try{ const v=JSON.parse(cached); form.username.value=v.username||''; }catch(e){} }
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const u=form.username.value.trim(); if(!u) return;
    status.textContent='Starting lookup...';
    try{
      const r=await fetch('https://api.github.com/users/'+encodeURIComponent(u), {headers: token?{Authorization:'Bearer '+token}:{}} );
      if(!r.ok) throw new Error('HTTP '+r.status);
      const j=await r.json();
      const d=new Date(j.created_at);
      const today=new Date();
      let years=today.getUTCFullYear()-d.getUTCFullYear();
      const m=today.getUTCMonth()-d.getUTCMonth();
      const dd=today.getUTCDate()-d.getUTCDate();
      if(m<0 || (m===0 && dd<0)) years--;
      created.textContent=d.toISOString().slice(0,10);
      age.textContent=years+' years';
      localStorage.setItem(key, JSON.stringify({username:u, created:j.created_at}));
      status.textContent='Success';
    }catch(err){ status.textContent='Failed: '+err.message; }
  });
})();
</script>
</body></html>`;

  const html_generic = `<!doctype html><html><head>
${commonHead}
<title>App</title></head><body>
<h1 class="h4">App Scaffolding</h1>
<p>Brief:</p>
<pre>${escapeHtml(brief)}</pre>
</body></html>`;

  const html =
    tpl==='sum-of-sales' ? html_sales :
    tpl==='markdown-to-html' ? html_md :
    tpl==='github-user-created' ? html_gh :
    html_generic;

  await fsp.writeFile(path.join(site,'index.html'), html, 'utf8');
  await fsp.writeFile(path.join(site,'.nojekyll'), '', 'utf8');

  // LICENSE
  await fsp.writeFile(path.join(workdir,'LICENSE'), MIT_LICENSE, 'utf8');

  // README
  const readme = `# ${tpl}\n\n**Round**: ${round}\n\n## Summary\n${brief}\n\n## Setup\nStatic site deployed by GitHub Pages via Actions.\n\n## Usage\nOpen the Pages URL.\n\n## Code\nSingle static page in \`/site\`.\n\n## License\nMIT\n`;
  await fsp.writeFile(path.join(workdir,'README.md'), readme, 'utf8');

  // Pages workflow
  const wfDir = path.join(workdir,'.github','workflows'); ensureDir(wfDir);
  const pagesYml = `name: Deploy Pages
on:
  push:
    branches: [ main ]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - uses: actions/deploy-pages@v4
`;
  await fsp.writeFile(path.join(wfDir,'pages.yml'), pagesYml, 'utf8');
}

const MIT_LICENSE = `MIT License

Copyright (c) ${new Date().getFullYear()}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`;

// --- git + repo ---
async function createOrUpdateRepo({ repo, workdir, msg }){
  const cwd = workdir;
  const run = (c)=>sh(c,{cwd});

  run(`git init`);
  run(`git config user.name "${CFG.authorName}"`);
  run(`git config user.email "${CFG.authorEmail}"`);

  try { run(`git remote remove origin`); } catch {}
const remote = `https://x-access-token:${CFG.token}@github.com/${CFG.user}/${repo}.git`;
run(`git remote add origin ${remote}`);


  // base on remote if exists
  let hasRemote = true;
  try { run(`git ls-remote --heads origin main`); }
  catch { hasRemote = false; }

  if (hasRemote) {
    run(`git fetch origin main`);
    run(`git checkout -B main origin/main`);
  } else {
    run(`git checkout -B main`);
  }

  // write current generator output on top
  run(`git add -A`);
  try { run(`git commit -m "${msg}"`); } catch {} // allow empty

  // always align to remote tip, then push
  if (hasRemote) run(`git pull --rebase origin main || :`);
  run(`git push --force-with-lease -u origin main`);

  return run(`git rev-parse HEAD`).trim();
}




// --- HTTP endpoint ---
app.post(['/api-endpoint','/task'], async (req, res) => {
  try{
    const b = req.body||{};
    if (String(b.secret||'') !== CFG.secret) return res.status(401).json({ ok:false, error:'bad secret' });
    for (const k of ['email','task','round','nonce','brief','evaluation_url']){
      if (!(k in b)) return res.status(400).json({ ok:false, error:`missing ${k}` });
    }

    const st = readState();
    const key = `${b.email}::${b.task}`;
    const round = Number(b.round)||1;
    let repo = st.tasks[key]?.repo || safeRepoName(b.task);
    const workdir = path.resolve('./tmp', repo);
    ensureDir(workdir);

    const tpl = pickTemplate(b.brief||'');
    const seed = extractSeed(b.brief||'', tpl);
    await generateSite({ workdir, brief:b.brief, attachments:b.attachments||[], tpl, seed, round });

    const sha = await createOrUpdateRepo({ repo, workdir, msg:`round ${round}: ${tpl}` });
    const repo_url = `https://github.com/${CFG.user}/${repo}`;
    const pages_url = `https://${CFG.user}.github.io/${repo}/`;

    st.tasks[key] = { repo, lastRound: round, updatedAt: now() };
    writeState(st);

    const payload = { email:b.email, task:b.task, round, nonce:b.nonce, repo_url, commit_sha:sha, pages_url };
    await notifyEvaluator(b.evaluation_url, payload);

    return res.status(200).json({ ok:true, repo_url, pages_url, commit_sha: sha });
  }catch(err){
    console.error(err);
    return res.status(500).json({ ok:false, error: String(err.message||err) });
  }
});

app.get('/healthz', (_req, res)=>res.json({ ok:true, time: now() }));

app.listen(CFG.port, ()=>console.log(`listening on :${CFG.port}`));
