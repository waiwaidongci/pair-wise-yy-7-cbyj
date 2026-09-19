import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);

// —— 领域常量 ——
// 索具任务四阶段，只能顺序推进，不能跳步
const TASK_STAGES = ["待检查", "调整中", "待复核", "已闭环"];
// 模型桶状态由未闭环任务派生：无未闭环任务即为「待命」
const MODEL_BUCKETS = ["待命", "待检查", "调整中", "待复核"];
const TENSIONS = ["偏松", "适中", "偏紧"];
// 可触发重核的模型参数
const RECHECK_FIELDS = [["scale", "比例"], ["dueDate", "交付日期"]];

const seed = {
  "version": 2,
  "items": [
    {
      "id": "MR-001",
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-10-15",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "revision": null,
          "basisScale": "1:48",
          "basisDueDate": "2026-10-15",
          "createdAt": "2026-09-08T02:10:00.000Z",
          "closedAt": null,
          "history": [
            { "at": "2026-09-08T02:10:00.000Z", "type": "创建", "note": "按建单参数立项（比例 1:48 / 交付 2026-10-15）" },
            { "at": "2026-09-09T06:30:00.000Z", "type": "检查", "note": "检查发现张挂后偏松，转入调整中" },
            { "at": "2026-09-12T03:05:00.000Z", "type": "调整记录", "note": "已缩短2mm，拟提交松紧修订" }
          ]
        },
        {
          "id": "T-2",
          "position": "后桅稳索",
          "tension": "适中",
          "status": "已闭环",
          "revision": null,
          "basisScale": "1:48",
          "basisDueDate": "2026-10-15",
          "createdAt": "2026-08-30T01:20:00.000Z",
          "closedAt": "2026-09-05T07:40:00.000Z",
          "history": [
            { "at": "2026-08-30T01:20:00.000Z", "type": "创建", "note": "按建单参数立项（比例 1:48 / 交付 2026-10-15）" },
            { "at": "2026-08-31T02:00:00.000Z", "type": "检查", "note": "张紧过度，转入调整中" },
            { "at": "2026-09-03T03:10:00.000Z", "type": "调整记录", "note": "松半圈，提交待复核修订" },
            { "at": "2026-09-05T07:40:00.000Z", "type": "复核通过", "from": "偏紧", "to": "适中", "note": "张力均匀，旧值归档" }
          ]
        }
      ],
      "logs": [
        { "at": "2026-09-08T02:10:00.000Z", "step": "建档", "note": "创建模型 MR-001" },
        { "at": "2026-09-08T02:12:00.000Z", "step": "索具", "note": "新建立项：前桅侧支索（待检查）" },
        { "at": "2026-09-05T07:40:00.000Z", "step": "闭环", "note": "后桅稳索复核通过：偏紧 → 适中，旧值归档" }
      ]
    },
    {
      "id": "MR-002",
      "code": "MR-002",
      "shipType": "广船",
      "scale": "1:72",
      "mastCount": 2,
      "riggingMaterial": "丝线",
      "owner": "林澄",
      "dueDate": "2026-11-20",
      "tasks": [
        {
          "id": "T-3",
          "position": "主桅升帆索",
          "tension": "适中",
          "status": "已闭环",
          "revision": null,
          "basisScale": "1:72",
          "basisDueDate": "2026-11-20",
          "createdAt": "2026-08-12T01:00:00.000Z",
          "closedAt": "2026-08-20T05:30:00.000Z",
          "history": [
            { "at": "2026-08-12T01:00:00.000Z", "type": "创建", "note": "按建单参数立项（比例 1:72 / 交付 2026-11-20）" },
            { "at": "2026-08-20T05:30:00.000Z", "type": "复核通过", "from": "偏松", "to": "适中", "note": "复核通过，旧值归档" }
          ]
        }
      ],
      "logs": [
        { "at": "2026-08-10T00:30:00.000Z", "step": "建档", "note": "创建模型 MR-002" },
        { "at": "2026-08-20T05:30:00.000Z", "step": "闭环", "note": "主桅升帆索复核通过：偏松 → 适中，旧值归档" }
      ]
    }
  ]
};

const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (db.version !== 2) {
    migrate(db);
    await saveDb(db);
  }
  return db;
}
// 旧版数据（无修订/历史概念）归一到复核台结构
function migrate(db) {
  db.version = 2;
  for (const item of db.items || []) {
    item.id ||= item.code;
    item.tasks ||= [];
    item.logs ||= [];
    let keptOpen = false;
    for (const t of item.tasks) {
      t.revision = null;
      t.closedAt = null;
      t.basisScale = item.scale;
      t.basisDueDate = item.dueDate;
      t.createdAt ||= new Date().toISOString();
      if (!TASK_STAGES.includes(t.status)) t.status = "待检查";
      t.history = (t.logs || []).map(l => ({ at: l.at, type: "调整记录", note: l.note || "" }));
      t.history.unshift({ at: t.createdAt, type: "创建", note: "旧站数据迁移立项" });
      delete t.logs;
      if (t.status !== "已闭环") {
        if (!keptOpen) { keptOpen = true; }
        else { t.status = "已闭环"; t.closedAt = new Date().toISOString(); t.history.push({ at: t.closedAt, type: "复核通过", from: t.tension, to: t.tension, note: "旧站并单，迁移归档" }); }
      }
    }
  }
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function nowAt() { return new Date().toISOString(); }
function newId(prefix) { return prefix + "-" + Date.now(); }
function openTask(item) {
  return (item.tasks || []).find(t => t.status !== "已闭环") || null;
}
function deriveStatus(item) {
  const t = openTask(item);
  return t ? t.status : "待命";
}
function addModelLog(item, step, note) {
  item.logs ||= [];
  item.logs.push({ at: nowAt(), step, note });
}
function addHistory(task, type, note, extra = {}) {
  task.history.push({ at: nowAt(), type, note, ...extra });
}
function findItem(db, ident) {
  return db.items.find(x => x.id === ident || x.code === ident) || null;
}
function findTask(item, tid) {
  return (item.tasks || []).find(t => t.id === tid) || null;
}
function summarize(item) {
  const open = openTask(item);
  const closedCount = (item.tasks || []).filter(t => t.status === "已闭环").length;
  return { ...item, status: deriveStatus(item), openTaskId: open ? open.id : null, closedCount };
}
function computeStats(items) {
  const stats = Object.fromEntries(MODEL_BUCKETS.map(label => [label, 0]));
  for (const item of items) stats[deriveStatus(item)] += 1;
  stats["已闭环任务"] = items.reduce((n, item) => n + (item.tasks || []).filter(t => t.status === "已闭环").length, 0);
  return stats;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索复核台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d2a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:17px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:.45; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:10px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:12px; font-weight:700; }
    .pill.待命 { background:#eef1ea; } .pill.待检查 { background:#e7eef6; color:#2f4d6b; } .pill.调整中 { background:#f6efdd; color:var(--hold); } .pill.待复核 { background:#f7e7e2; color:var(--warn); }
    .info { display:grid; grid-template-columns:1fr 1fr; gap:4px 10px; font-size:13px; } .info b { color:var(--muted); font-weight:400; }
    .stepper { display:flex; align-items:center; gap:0; } .step { flex:1; text-align:center; font-size:12px; color:var(--muted); position:relative; padding:6px 0; }
    .step::before { content:""; position:absolute; top:50%; left:-50%; width:100%; height:2px; background:var(--line); z-index:0; } .step:first-child::before { display:none; }
    .step span { position:relative; z-index:1; background:#fff; padding:2px 6px; border-radius:999px; }
    .step.done { color:var(--accent); } .step.done::before { background:var(--accent); } .step.done span { background:var(--accent); color:#fff; }
    .step.current span { border:2px solid var(--accent); font-weight:700; color:var(--accent); }
    .taskbox { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:#fcfdfb; display:grid; gap:8px; }
    .rev { border:1px dashed var(--warn); border-radius:6px; padding:8px 10px; background:#fdf4f1; font-size:13px; }
    .row { display:flex; gap:8px; align-items:center; } .row > * { flex:1; } .row button { flex:0 0 auto; }
    .archive { border-top:1px solid var(--line); padding-top:8px; } .archive div { font-size:13px; padding:2px 0; }
    .timeline { border-top:1px solid var(--line); padding-top:8px; max-height:150px; overflow:auto; display:grid; gap:3px; } .timeline div { font-size:12px; color:var(--muted); } .timeline b { color:var(--ink); font-weight:700; }
    .params { display:grid; grid-template-columns:1fr 1fr auto; gap:6px; align-items:end; border-top:1px dashed var(--line); padding-top:8px; }
    .hint { font-size:12px; color:var(--hold); } .err { color:var(--warn); font-size:13px; font-weight:700; }
    .btnrow { display:flex; gap:8px; } .btnrow form { flex:1; padding:0; border:0; } .btnrow button { width:100%; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索复核台</h1><div class="meta">一型一单 · 待检查 → 调整中 → 待复核 → 已闭环，不得跳步；复核通过才换值归档</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><button>保存模型</button></form>
      <form id="taskForm" style="margin-top:14px"><h2>新增索具任务</h2><div class="meta">每个模型只允许一项未闭环任务，闭环后方可再立。</div><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>立项检查</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${MODEL_BUCKETS.map(s => '<option>' + s + '</option>').join('')}</select><input id="search" placeholder="搜索编号 / 船型 / 索位"></div>
      <div class="panel"><h2>帆索复核看板</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","调整中","待复核","已闭环"];
    const buckets = ["待命","待检查","调整中","待复核"];
    const tensions = ["偏松","适中","偏紧"];
    const typeLabels = {"创建":"立项","检查":"检查","调整记录":"调整","提交修订":"修订","重复提交":"重复修订","复核通过":"通过","驳回":"驳回","参数重核":"参数重核"};
    const createForm = document.querySelector('#createForm');
    const taskForm = document.querySelector('#taskForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmtAt(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : ''; }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'||key==='shipType'||key==='scale'||key==='dueDate'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML =
        '<label>索具位置（立项后锁定）</label><input name="position" required>' +
        '<label>当前松紧（原值）</label><select name="tension">' + tensions.map(t => '<option>'+t+'</option>').join('') + '</select>' +
        '<label>备注</label><input name="note" placeholder="如：目视初查情况">';
    }
    function render() {
      itemSelect.innerHTML = items.map(item => {
        const ready = item.status === '待命';
        return '<option value="'+esc(item.id)+'" '+(ready?'':'disabled')+'>'+esc(item.code)+' · '+esc(item.shipType)+(ready?'（待命，可立项）':'（'+esc(item.status)+'，不可立项）')+'</option>';
      }).join('') || '<option value="">暂无模型</option>';
      const stats = Object.fromEntries(buckets.map(s => [s, items.filter(i => i.status === s).length]));
      stats['已闭环任务'] = items.reduce((n, i) => n + (i.closedCount || 0), 0);
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(cardHtml).join('') || '<div class="meta">没有符合条件的模型。</div>';
    }
    function stepperHtml(stage) {
      return '<div class="stepper">' + stages.slice(0,3).map((s, i) => {
        const cur = stages.indexOf(stage);
        const cls = i < cur ? 'done' : (i === cur ? (s === '已闭环' ? 'done' : 'current') : '');
        return '<div class="step '+cls+'"><span>'+s+'</span></div>';
      }).join('') + '</div>';
    }
    function openTaskHtml(item, t) {
      let action = '';
      if (t.status === '待检查') {
        action = '<form data-wf data-item="'+esc(item.id)+'" data-task="'+esc(t.id)+'">'
          + stepperHtml(t.status)
          + '<div class="meta">索具位置已锁定：<b>'+esc(t.position)+'</b>　当前有效值：<b>'+esc(t.tension)+'</b></div>'
          + '<input name="note" placeholder="检查备注（可选）">'
          + '<button name="action" value="begin_adjust">检查完成，进入调整</button></form>';
      } else if (t.status === '调整中') {
        action = '<form data-wf data-item="'+esc(item.id)+'" data-task="'+esc(t.id)+'">'
          + stepperHtml(t.status)
          + '<div class="meta">索具位置已锁定：<b>'+esc(t.position)+'</b>　原值继续有效：<b>'+esc(t.tension)+'</b></div>'
          + '<label>调整后松紧（仅此项生成待复核修订，其余参数锁定不变）</label>'
          + '<div class="row"><select name="tension">' + tensions.map(x => '<option '+(x===t.tension?'selected':'')+'>'+x+'</option>').join('') + '</select></div>'
          + '<input name="note" placeholder="调整做法，如：收紧半圈">'
          + '<button name="action" value="submit_revision">提交一条待复核修订</button></form>';
      } else if (t.status === '待复核') {
        const r = t.revision || {};
        action = '<form data-wf data-item="'+esc(item.id)+'" data-task="'+esc(t.id)+'">'
          + stepperHtml(t.status)
          + '<div class="rev"><b>待复核修订（唯一）</b><br>松紧：'+esc(t.tension)+' → <b>'+esc(r.tension)+'</b>（原值未替换，继续有效）<br>调整备注：'+esc(r.note || '—')+'<br>提交：'+fmtAt(r.createdAt)+(r.submitCount>1?'　·　已重复提交 '+esc(r.submitCount)+' 次，沿用首次修订':'')+'</div>'
          + '<input name="note" placeholder="驳回意见（驳回时填写）">'
          + '<div class="btnrow"><button class="danger" name="action" value="reject">驳回</button><button name="action" value="approve">复核通过</button></div></form>';
      }
      return '<div class="taskbox"><div class="row"><h3>未闭环索具任务 · '+esc(t.position)+'</h3><span class="pill '+esc(t.status)+'">'+esc(t.status)+'</span></div>'+action+'</div>';
    }
    function cardHtml(item) {
      const open = (item.tasks || []).find(t => t.status !== '已闭环');
      const closed = (item.tasks || []).filter(t => t.status === '已闭环');
      const events = [];
      for (const t of item.tasks || []) for (const h of t.history || []) events.push({ at: h.at, text: esc(t.position)+' · <b>'+esc(typeLabels[h.type] || h.type)+'</b> ' + esc(h.note || '') + ((h.from && h.to) ? '（'+esc(h.from)+' → '+esc(h.to)+'）' : '') });
      for (const l of item.logs || []) events.push({ at: l.at, text: '模型 · <b>'+esc(l.step)+'</b> '+esc(l.note || '') });
      events.sort((a, b) => a.at < b.at ? 1 : -1);
      const timeline = events.slice(0, 12).map(e => '<div>'+fmtAt(e.at)+'　'+e.text+'</div>').join('');
      const archive = closed.map(t => {
        const pass = (t.history || []).slice().reverse().find(h => h.type === '复核通过');
        return '<div>✓ '+esc(t.position)+'：' + (pass ? esc(pass.from)+' → '+esc(pass.to)+'（旧值已归档，'+fmtAt(t.closedAt)+'）' : esc(t.tension)+'（'+fmtAt(t.closedAt)+'）') + '</div>';
      }).join('');
      return '<article class="card">'
        + '<div class="row"><h3>'+esc(item.code)+' · '+esc(item.shipType)+'</h3><span class="pill '+esc(item.status)+'">'+esc(item.status)+'</span></div>'
        + '<div class="info">'
        +   '<div><b>桅杆</b> '+esc(item.mastCount)+'</div><div><b>帆索材料</b> '+esc(item.riggingMaterial)+'</div>'
        +   '<div><b>负责人</b> '+esc(item.owner)+'</div><div><b>建单参数</b> '+(open ? esc(open.basisScale)+' / '+esc(open.basisDueDate) : '—')+'</div>'
        + '</div>'
        + '<form class="params" data-params data-item="'+esc(item.id)+'">'
        +   '<div><label>比例（变更触发重核）</label><input name="scale" value="'+esc(item.scale)+'"></div>'
        +   '<div><label>交付日期（变更触发重核）</label><input name="dueDate" type="date" value="'+esc(item.dueDate)+'"></div>'
        +   '<button class="secondary" type="submit">改参数</button>'
        + '</form>'
        + '<div class="hint">比例或交付日期变更后，未闭环任务回到待检查按新参数重核；旧结论失效，过程仍留在时间线。</div>'
        + (open ? openTaskHtml(item, open) : '<div class="taskbox"><h3>待命</h3><div class="meta">无未闭环索具任务，可从左侧「新增索具任务」立项。</div></div>')
        + (archive ? '<div class="archive"><b>已闭环归档（'+closed.length+'）</b>'+archive+'</div>' : '')
        + '<div class="timeline">'+(timeline || '<div>暂无记录</div>')+'</div>'
        + '</article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    async function postAction(path, payload) {
      try { await api(path, { method: 'POST', body: JSON.stringify(payload) }); }
      catch (e) { alert(e.message); }
      await load();
    }
    createForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(createForm).entries());
      try { await api('/api/items', { method: 'POST', body: JSON.stringify(data) }); createForm.reset(); }
      catch (e) { alert(e.message); }
      await load();
    };
    taskForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(taskForm).entries());
      if (!data.id) return;
      try { await api('/api/items/' + encodeURIComponent(data.id) + '/tasks', { method: 'POST', body: JSON.stringify(data) }); taskForm.reset(); }
      catch (e) { alert(e.message); }
      await load();
    };
    cards.addEventListener('submit', async event => {
      const wf = event.target.closest('form[data-wf]');
      if (wf && event.target === wf) {
        event.preventDefault();
        const action = (event.submitter && event.submitter.value) || wf.dataset.action;
        const data = Object.fromEntries(new FormData(wf).entries());
        await postAction('/api/items/' + encodeURIComponent(wf.dataset.item) + '/tasks/' + encodeURIComponent(wf.dataset.task) + '/transition', { method: 'POST', action, ...data });
      }
      const pf = event.target.closest('form[data-params]');
      if (pf && event.target === pf) {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(pf).entries());
        await postAction('/api/items/' + encodeURIComponent(pf.dataset.item), { method: 'PATCH', body: JSON.stringify(data) });
      }
    });
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    renderForms();
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    // 新建模型
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!input.code || !String(input.code).trim()) return send(res, 400, { error: "模型编号必填" });
      if (!input.shipType || !input.scale || !input.dueDate) return send(res, 400, { error: "船型、比例、交付日期必填" });
      if (findItem(db, String(input.code).trim())) return send(res, 409, { error: "模型编号已存在" });
      const item = {
        id: newId("MR"),
        ...Object.fromEntries(fields.map(([key]) => [key, key === "mastCount" ? (Number(input[key]) || null) : (input[key] ?? "")])),
        code: String(input.code).trim(),
        tasks: [],
        logs: []
      };
      item.logs.push({ at: nowAt(), step: "建档", note: "创建模型 " + item.code });
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "模型不存在" });
      const input = await body(req);
      const changes = [];
      for (const [key, label] of RECHECK_FIELDS) {
        if (input[key] !== undefined && String(input[key]) !== "" && String(input[key]) !== String(item[key])) {
          changes.push({ field: key, label, from: item[key], to: String(input[key]) });
        }
      }
      if (!changes.length) return send(res, 200, summarize(item));
      for (const c of changes) item[c.field] = c.to;
      addModelLog(item, "参数变更", changes.map(c => `${c.label} ${c.from} → ${c.to}`).join("；"));
      // 比例或交付日期变更：未闭环任务按新参数重核，旧结论失效（待复核修订一并作废），原值继续有效
      const t = openTask(item);
      if (t) {
        const discarded = t.revision;
        t.revision = null;
        t.status = "待检查";
        t.basisScale = item.scale;
        t.basisDueDate = item.dueDate;
        const desc = changes.map(c => `${c.label}${c.from}→${c.to}`).join("、");
        addHistory(t, "参数重核", `模型${desc}，未闭环任务按新参数重核，旧结论失效` + (discarded ? `；待复核修订「${discarded.tension}」作废，原值「${t.tension}」继续有效` : "；原值继续有效"), { changes });
        addModelLog(item, "重核", `${t.position} 回到待检查按新参数重核`);
      }
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    // 新增索具任务：每模型至多一项未闭环
    const addTask = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks$/);
    if (addTask && req.method === "POST") {
      const item = findItem(db, addTask[1]);
      if (!item) return send(res, 404, { error: "模型不存在" });
      if (openTask(item)) return send(res, 409, { error: "该模型已有未闭环索具任务，闭环后才能再立项" });
      const input = await body(req);
      if (!input.position || !String(input.position).trim()) return send(res, 400, { error: "索具位置必填" });
      if (!TENSIONS.includes(input.tension)) return send(res, 400, { error: "松紧原值需为：偏松 / 适中 / 偏紧" });
      const task = {
        id: newId("T"),
        position: String(input.position).trim(),
        tension: input.tension,
        status: "待检查",
        revision: null,
        basisScale: item.scale,
        basisDueDate: item.dueDate,
        createdAt: nowAt(),
        closedAt: null,
        history: []
      };
      addHistory(task, "创建", `按建单参数立项（比例 ${item.scale} / 交付 ${item.dueDate}）${input.note ? "；" + input.note : ""}`);
      item.tasks.push(task);
      addModelLog(item, "索具", `新建立项：${task.position}（待检查，原值 ${task.tension}）`);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    // 任务阶段流转：顺序推进，不能跳步
    const transition = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/transition$/);
    if (transition && req.method === "POST") {
      const item = findItem(db, transition[1]);
      if (!item) return send(res, 404, { error: "模型不存在" });
      const task = findTask(item, transition[2]);
      if (!task) return send(res, 404, { error: "索具任务不存在" });
      const input = await body(req);
      const guard = (expected) => {
        if (task.status === expected) return false;
        send(res, 409, { error: `任务当前为「${task.status}」，不能执行该操作（需处于「${expected}」）` });
        return true;
      };
      switch (input.action) {
        case "begin_adjust": {
          if (guard("待检查")) return;
          task.status = "调整中";
          addHistory(task, "检查", `检查完成，进入调整${input.note ? "；" + input.note : ""}`);
          addModelLog(item, "检查", `${task.position} 待检查 → 调整中`);
          break;
        }
        case "submit_revision": {
          // 重复提交沿用首次修订：已在待复核时不再生成新修订
          if (task.status === "待复核") {
            task.revision.submitCount = (task.revision.submitCount || 1) + 1;
            addHistory(task, "重复提交", `重复提交调整，沿用首次待复核修订「${task.revision.tension}」`);
            addModelLog(item, "修订", `${task.position} 重复提交，沿用首次修订`);
            await saveDb(db);
            return send(res, 200, { ...summarize(item), reused: true });
          }
          if (guard("调整中")) return;
          if (!TENSIONS.includes(input.tension)) return send(res, 400, { error: "修订松紧需为：偏松 / 适中 / 偏紧" });
          if (input.tension === task.tension) return send(res, 400, { error: "修订松紧与原值相同，无需提交" });
          // 只生成一条待复核修订；锁定参数（索具位置等）保持不变；原值不替换
          task.revision = { tension: input.tension, note: input.note || "", createdAt: nowAt(), submitCount: 1 };
          task.status = "待复核";
          addHistory(task, "提交修订", `提交待复核修订：${task.tension} → ${input.tension}，锁定参数不变；备注：${input.note || "—"}`);
          addModelLog(item, "修订", `${task.position} 调整中 → 待复核（${task.tension} → ${input.tension}）`);
          break;
        }
        case "approve": {
          if (guard("待复核")) return;
          // 复核通过才替换并归档旧值
          const from = task.tension;
          const to = task.revision.tension;
          addHistory(task, "复核通过", `复核通过，新值替换原值并归档；调整备注：${task.revision.note || "—"}`, { from, to });
          task.tension = to;
          task.status = "已闭环";
          task.closedAt = nowAt();
          task.revision = null;
          addModelLog(item, "闭环", `${task.position} 复核通过：${from} → ${to}，旧值归档`);
          break;
        }
        case "reject": {
          if (guard("待复核")) return;
          // 驳回：修订作废，原值继续有效，回到调整中
          const proposed = task.revision.tension;
          addHistory(task, "驳回", `驳回修订「${proposed}」，原值「${task.tension}」继续有效${input.note ? "；意见：" + input.note : ""}`, { proposed });
          addModelLog(item, "驳回", `${task.position} 待复核 → 调整中，原值 ${task.tension} 继续有效`);
          task.revision = null;
          task.status = "调整中";
          break;
        }
        default:
          return send(res, 400, { error: "未知操作" });
      }
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索复核台 listening on http://localhost:" + port));
