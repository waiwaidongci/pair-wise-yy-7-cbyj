import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);

// 索具任务四级流转：待检查 → 调整中 → 待复核 → 已闭环，不允许跳步
const STAGES = ["待检查", "调整中", "待复核", "已闭环"];
const TENSIONS = ["偏松", "适中", "偏紧"];
const META_FIELDS = [
  ["code", "模型编号", "text"],
  ["shipType", "船型", "text"],
  ["scale", "比例", "text"],
  ["mastCount", "桅杆数量", "number"],
  ["riggingMaterial", "帆索材料", "text"],
  ["owner", "负责人", "text"],
  ["dueDate", "交付日期", "date"],
];
// 仅比例、交付日期变更会让未闭环任务按新参数重核
const PARAM_FIELDS = ["scale", "dueDate"];
const PARAM_LABELS = { scale: "比例", dueDate: "交付日期" };

const seed = {
  items: [
    {
      id: "MR-seed-001",
      code: "MR-001",
      shipType: "福船",
      scale: "1:48",
      mastCount: 3,
      riggingMaterial: "蜡线",
      owner: "周宁",
      dueDate: "2026-10-28",
      paramVersion: 1,
      tasks: [
        {
          id: "T-1001",
          position: "前桅侧支索",
          tension: "偏松",
          status: "待复核",
          paramVersion: 1,
          createdAt: "2026-09-05T08:30:00.000Z",
          closedAt: null,
          revision: {
            tension: "适中",
            note: "缩短2mm，两侧绳花收紧一致",
            at: "2026-09-15T09:20:00.000Z",
            paramVersion: 1,
          },
          history: [
            {
              at: "2026-09-12T10:00:00.000Z",
              type: "驳回",
              tension: "偏紧",
              paramVersion: 1,
              note: "一次收得过紧，桅顶支索角度偏移，原值继续有效",
            },
          ],
          logs: [
            { at: "2026-09-05T08:30:00.000Z", note: "索具任务建档，初检偏松" },
            { at: "2026-09-08T09:00:00.000Z", note: "开始调整" },
            { at: "2026-09-12T10:00:00.000Z", note: "修订被驳回，回到调整中" },
            { at: "2026-09-15T09:20:00.000Z", note: "提交待复核修订：偏松 → 适中" },
          ],
        },
      ],
      logs: [
        { at: "2026-09-02T08:00:00.000Z", step: "建档", note: "创建模型 MR-001" },
        { at: "2026-09-05T08:30:00.000Z", step: "索具", note: "新增索具任务：前桅侧支索" },
        { at: "2026-09-12T10:00:00.000Z", step: "复核", note: "前桅侧支索修订驳回，原值继续有效" },
        { at: "2026-09-15T09:20:00.000Z", step: "调整", note: "前桅侧支索提交待复核修订" },
      ],
    },
    {
      id: "MR-seed-002",
      code: "MR-002",
      shipType: "沙船",
      scale: "1:72",
      mastCount: 2,
      riggingMaterial: "棉线",
      owner: "林岫",
      dueDate: "2026-11-10",
      paramVersion: 1,
      tasks: [
        {
          id: "T-1002",
          position: "主桅缭绳",
          tension: "适中",
          status: "已闭环",
          paramVersion: 1,
          createdAt: "2026-09-03T08:30:00.000Z",
          closedAt: "2026-09-10T15:00:00.000Z",
          revision: null,
          history: [
            {
              at: "2026-09-10T15:00:00.000Z",
              type: "归档",
              from: "偏松",
              to: "适中",
              paramVersion: 1,
              note: "收紧半圈，复核通过，旧值归档",
            },
          ],
          logs: [
            { at: "2026-09-03T08:30:00.000Z", note: "索具任务建档，初检偏松" },
            { at: "2026-09-09T11:00:00.000Z", note: "提交待复核修订：偏松 → 适中" },
            { at: "2026-09-10T15:00:00.000Z", note: "复核通过，旧值归档，任务闭环" },
          ],
        },
      ],
      logs: [
        { at: "2026-09-01T08:00:00.000Z", step: "建档", note: "创建模型 MR-002" },
        { at: "2026-09-10T15:00:00.000Z", step: "复核", note: "主桅缭绳复核通过并归档旧值" },
      ],
    },
    {
      id: "MR-seed-003",
      code: "MR-003",
      shipType: "广船",
      scale: "1:96",
      mastCount: 2,
      riggingMaterial: "丝线",
      owner: "周宁",
      dueDate: "2026-12-05",
      paramVersion: 1,
      tasks: [],
      logs: [{ at: "2026-09-16T08:00:00.000Z", step: "建档", note: "创建模型 MR-003" }],
    },
  ],
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  for (const item of db.items || []) migrate(item);
  return db;
}
async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
// 兼容旧版数据结构，补齐复核台所需字段
function migrate(item) {
  item.paramVersion ||= 1;
  item.tasks ||= [];
  item.logs ||= [];
  for (const t of item.tasks) {
    if (t.status === "校准中") t.status = "调整中";
    if (t.status === "已交付") t.status = "已闭环";
    if (!STAGES.includes(t.status)) t.status = "待检查";
    t.history ||= [];
    t.logs ||= [];
    t.paramVersion ||= item.paramVersion;
    t.revision ??= null;
    t.closedAt ??= null;
  }
}
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
const now = () => new Date().toISOString();
const newId = (p) => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const openTask = (item) => (item.tasks || []).find((t) => t.status !== "已闭环") || null;
function modelStatus(item) {
  const t = openTask(item);
  if (t) return t.status;
  return item.tasks.length ? "已闭环" : "待检查";
}
function summarize(item) {
  const t = openTask(item);
  return { ...item, status: modelStatus(item), openTaskId: t ? t.id : null };
}
function computeStats(items) {
  const stats = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const item of items) stats[modelStatus(item)] += 1;
  return stats;
}
function findItem(db, id) {
  const item = db.items.find((x) => x.id === id || x.code === id);
  if (!item) throw new ApiError(404, "模型不存在");
  return item;
}
function findTask(item, tid) {
  const task = (item.tasks || []).find((t) => t.id === tid);
  if (!task) throw new ApiError(404, "索具任务不存在");
  return task;
}
function pushModelLog(item, step, note) {
  item.logs.push({ at: now(), step, note });
}
function cleanMeta(input) {
  const out = {};
  for (const [key] of META_FIELDS) {
    if (input[key] !== undefined) {
      out[key] = key === "mastCount" ? input[key] === "" || input[key] == null ? null : Number(input[key]) : String(input[key]);
    }
  }
  return out;
}

// 创建索具任务：每模型只允许一项未闭环任务
function createTask(item, input) {
  if (openTask(item)) {
    throw new ApiError(409, "该模型已有未闭环索具任务，需闭环后才能新增");
  }
  const position = (input.position || "").trim();
  const tension = (input.tension || "").trim();
  if (!position) throw new ApiError(400, "索具位置不能为空");
  if (!TENSIONS.includes(tension)) throw new ApiError(400, "松紧状态无效");
  const task = {
    id: newId("T"),
    position,
    tension,
    status: "待检查",
    paramVersion: item.paramVersion,
    createdAt: now(),
    closedAt: null,
    revision: null,
    history: [],
    logs: [{ at: now(), note: "索具任务建档，初检" + tension + (input.note ? "：" + input.note : "") }],
  };
  item.tasks.push(task);
  pushModelLog(item, "索具", "新增索具任务：" + position + "（初检" + tension + "）");
  return task;
}

// 任务流转动作：start / adjust / approve / reject
function transition(item, task, input) {
  const action = input.action;
  const at = now();
  if (action === "start") {
    if (task.status !== "待检查") throw new ApiError(409, "只有待检查任务可以开始调整，不能跳步");
    task.status = "调整中";
    task.logs.push({ at, note: "开始调整" });
    return { note: "已进入调整中" };
  }
  if (action === "adjust") {
    // 重复提交沿用首次修订：已存在待复核修订时原样返回，不再生成新修订
    if (task.status === "待复核" && task.revision) {
      task.logs.push({ at, note: "重复提交调整，沿用首次待复核修订" });
      return { note: "已存在待复核修订，沿用首次修订", reused: true };
    }
    if (task.status !== "调整中") throw new ApiError(409, "只有调整中任务可以提交松紧调整，不能跳步");
    const tension = (input.tension || "").trim();
    if (!TENSIONS.includes(tension)) throw new ApiError(400, "松紧状态无效");
    // 只生成一条待复核修订；索具位置等锁定参数保持不变
    task.revision = { tension, note: (input.note || "").trim(), at, paramVersion: task.paramVersion };
    task.status = "待复核";
    task.logs.push({ at, note: "提交待复核修订：" + task.tension + " → " + tension });
    pushModelLog(item, "调整", task.position + " 提交待复核修订");
    return { note: "已生成待复核修订" };
  }
  if (action === "approve") {
    if (task.status !== "待复核" || !task.revision) throw new ApiError(409, "没有待复核修订，不能复核通过");
    const rev = task.revision;
    // 通过才替换当前值，旧值归档进历史
    task.history.push({
      at,
      type: "归档",
      from: task.tension,
      to: rev.tension,
      paramVersion: rev.paramVersion,
      note: "复核通过，旧值归档" + (rev.note ? "（" + rev.note + "）" : ""),
    });
    task.tension = rev.tension;
    task.revision = null;
    task.status = "已闭环";
    task.closedAt = at;
    task.logs.push({ at, note: "复核通过，旧值归档，任务闭环" });
    pushModelLog(item, "复核", task.position + " 复核通过，" + "旧值已归档");
    return { note: "复核通过，已替换并归档旧值" };
  }
  if (action === "reject") {
    if (task.status !== "待复核" || !task.revision) throw new ApiError(409, "没有待复核修订，不能驳回");
    const rev = task.revision;
    // 驳回：修订不入正册，原值继续有效，任务回到调整中
    task.history.push({
      at,
      type: "驳回",
      tension: rev.tension,
      paramVersion: rev.paramVersion,
      note: "复核驳回，修订未采纳，原值继续有效" + (input.note ? "：" + input.note : ""),
    });
    task.revision = null;
    task.status = "调整中";
    task.logs.push({ at, note: "修订被驳回，原值继续有效，回到调整中" });
    pushModelLog(item, "复核", task.position + " 修订驳回，原值继续有效");
    return { note: "已驳回，原值继续有效" };
  }
  throw new ApiError(400, "未知动作");
}

// 比例 / 交付日期变更：未闭环任务按新参数重核，旧结论失效但历史可查
function applyMetaPatch(item, input) {
  const next = cleanMeta(input);
  const changes = [];
  for (const key of PARAM_FIELDS) {
    if (next[key] !== undefined && next[key] !== (item[key] ?? "")) {
      changes.push({ key, from: item[key] || "空", to: next[key] || "空" });
    }
  }
  Object.assign(item, next);
  if (!changes.length) {
    pushModelLog(item, "参数", "模型资料更新");
    return { rechecked: false };
  }
  item.paramVersion = (item.paramVersion || 1) + 1;
  const desc = changes.map((c) => PARAM_LABELS[c.key] + " " + c.from + " → " + c.to).join("，");
  for (const t of item.tasks) {
    if (t.status === "已闭环") continue; // 已闭环任务不受影响
    if (t.revision) {
      t.history.push({
        at: now(),
        type: "参数失效",
        tension: t.revision.tension,
        paramVersion: t.revision.paramVersion,
        note: "模型" + desc + "，该待复核修订依据旧参数作出，结论失效",
      });
      t.revision = null;
    }
    t.status = "待检查";
    t.paramVersion = item.paramVersion;
    t.logs.push({ at: now(), note: "模型" + desc + "，按新参数重核，旧结论失效" });
  }
  pushModelLog(item, "参数变更", desc + "；未闭环任务重回待检查，旧结论失效，历史留存");
  return { rechecked: true, desc };
}

function page() {
  const metaInputs = META_FIELDS.map(
    ([key, label, type]) =>
      '<label>' + label + '</label><input name="' + key + '" type="' + type + '"' + (key === "code" ? " required" : "") + ">"
  ).join("");
  const stageOptions = STAGES.map((s) => "<option>" + s + "</option>").join("");
  const tensionOptions = TENSIONS.map((s) => "<option>" + s + "</option>").join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索复核台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --gold:#a07a2c; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:17px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:56px; resize:vertical; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; } button:disabled { opacity:.55; cursor:default; }
    button.secondary { background:#69736a; } button.warn { background:var(--warn); } button.small { padding:6px 10px; font-size:13px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:12px; font-weight:700; }
    .pill-待检查 { background:#eef1ec; color:#687066; } .pill-调整中 { background:#fdf3df; color:#8a6420; border-color:#e3cf9d; }
    .pill-待复核 { background:#f7e7e2; color:#9b4937; border-color:#e2b7ac; } .pill-已闭环 { background:#e4ede0; color:#425c35; border-color:#bccfb2; }
    .infogrid { display:grid; grid-template-columns:1fr 1fr; gap:4px 10px; font-size:13px; }
    .steps { display:flex; gap:6px; list-style:none; padding:0; margin:8px 0; } .steps li { flex:1; text-align:center; border:1px solid var(--line); border-radius:6px; padding:4px 0; font-size:12px; color:var(--muted); background:#f7f9f5; }
    .steps li.done { background:#e4ede0; color:var(--accent); border-color:#bcd0b2; } .steps li.now { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:700; }
    .task { border-top:1px dashed var(--line); padding-top:8px; margin-top:8px; display:grid; gap:6px; } .task.closed { opacity:.86; }
    .revise { border:1px dashed #d3b36a; background:#fdf8ec; border-radius:8px; padding:10px; display:grid; gap:6px; }
    .btns { display:flex; gap:8px; flex-wrap:wrap; }
    .hist { list-style:none; margin:6px 0 0; padding:0; display:grid; gap:4px; } .hist li { font-size:12.5px; border-left:3px solid var(--line); padding:2px 8px; background:#fafbf8; border-radius:0 6px 6px 0; }
    .hist li.h-归档 { border-left-color:var(--accent); } .hist li.h-驳回 { border-left-color:var(--warn); } .hist li.h-参数失效 { border-left-color:var(--gold); }
    .tag { font-weight:700; margin-right:4px; } .tag-归档 { color:var(--accent); } .tag-驳回 { color:var(--warn); } .tag-参数失效 { color:var(--gold); }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:96px; overflow:auto; display:grid; gap:3px; font-size:12.5px; }
    .msg { margin-top:12px; border-radius:6px; padding:10px; font-size:13px; display:none; } .msg.err { display:block; background:#f7e7e2; color:#8c3b2c; border:1px solid #e2b7ac; }
    .msg.ok { display:block; background:#e7efe2; color:#3c5531; border:1px solid #b8cfae; }
    .lock { font-size:12.5px; color:var(--muted); } .paramform { display:grid; grid-template-columns:1fr 130px auto; gap:6px; align-items:end; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .paramform{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索复核台</h1><div class="meta">每模型一项未闭环任务 · 待检查 → 调整中 → 待复核 → 已闭环，不可跳步 · 复核通过才替换归档，驳回原值有效</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2>${metaInputs}<button style="margin-top:12px">保存模型</button></form>
      <form id="taskForm" style="margin-top:14px">
        <h2>新增索具任务</h2>
        <label>选择模型</label><select name="id" id="itemSelect"></select>
        <div class="meta" id="taskHint"></div>
        <label>索具位置（锁定参数）</label><input name="position" required placeholder="如：前桅侧支索">
        <label>初检松紧</label><select name="tension">${tensionOptions}</select>
        <label>初检备注</label><textarea name="note"></textarea>
        <button style="margin-top:12px">提交任务（待检查）</button>
      </form>
      <div class="msg" id="msg"></div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${stageOptions}</select>
        <input id="search" placeholder="搜索编号 / 船型 / 负责人 / 索具位置">
      </div>
      <div class="panel">
        <h2 class="meta" style="font-weight:400">调整松紧只会生成一条待复核修订；重复提交沿用首次修订。比例或交付日期变更后，未闭环任务按新参数重核。</h2>
        <div class="grid" id="cards"></div>
      </div>
    </section>
  </main>
  <script>
    var STAGES = ["待检查","调整中","待复核","已闭环"];
    var TENSIONS = ["偏松","适中","偏紧"];
    var items = [];
    var busy = false;
    var $ = function (s) { return document.querySelector(s); };
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]; }); }
    function fmt(at) { return at ? new Date(at).toLocaleString("zh-CN", { hour12:false }) : ""; }
    async function api(path, options) {
      var res = await fetch(path, options && options.body ? Object.assign({}, options, { headers: { "Content-Type": "application/json" } }) : options);
      var data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    function showMsg(text, ok) { var m = $("#msg"); m.className = "msg " + (ok ? "ok" : "err"); m.textContent = text; }
    function clearMsg() { var m = $("#msg"); m.className = "msg"; m.textContent = ""; }

    function taskHtml(item, t) {
      var idx = STAGES.indexOf(t.status);
      var steps = '<ol class="steps">' + STAGES.map(function (s, i) {
        return '<li class="' + (i < idx ? "done" : i === idx ? "now" : "") + '">' + s + "</li>";
      }).join("") + "</ol>";
      var head = '<div>🔒 <b>' + esc(t.position) + '</b> <span class="meta">参数版本 v' + t.paramVersion + (t.closedAt ? " · 闭环于 " + fmt(t.closedAt) : "") + "</span></div>";
      var cur = '<div>当前有效松紧：<b>' + esc(t.tension) + '</b></div>';
      var panel = "";
      if (t.status === "待检查") {
        panel = '<div class="btns"><button data-act="start" data-item="' + esc(item.id) + '" data-task="' + esc(t.id) + '">开始调整</button></div>';
      } else if (t.status === "调整中") {
        panel = '<form class="card" style="padding:10px" data-act="adjust" data-item="' + esc(item.id) + '" data-task="' + esc(t.id) + '">'
          + '<div class="lock">锁定：索具位置与模型参数保持不变，仅登记松紧修订</div>'
          + '<label>调整后松紧</label><select name="tension">' + TENSIONS.map(function (x) { return '<option' + (x === t.tension ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select>"
          + '<label>调整备注</label><textarea name="note" placeholder="如：缩短2mm"></textarea>'
          + '<div class="btns" style="margin-top:8px"><button>提交调整（生成待复核修订）</button></div></form>';
      } else if (t.status === "待复核" && t.revision) {
        panel = '<div class="revise"><div>待复核修订：<span class="tag tag-驳回">' + esc(t.revision.tension) + "</span>"
          + '<span class="meta">（当前值 ' + esc(t.tension) + "，依据 v" + t.revision.paramVersion + "）</span></div>"
          + '<div class="meta">备注：' + esc(t.revision.note || "无") + " · " + fmt(t.revision.at) + "</div>"
          + '<div class="meta">重复提交将沿用此首次修订；通过后替换并归档旧值，驳回则原值继续有效</div>"
          + '<div class="btns"><button data-act="approve" data-item="' + esc(item.id) + '" data-task="' + esc(t.id) + '">复核通过</button>'
          + '<button class="warn" data-act="reject" data-item="' + esc(item.id) + '" data-task="' + esc(t.id) + '">复核驳回</button></div></div>';
      } else {
        panel = '<div class="meta">已闭环，最终松紧：<b>' + esc(t.tension) + "</b></div>";
      }
      var hist = t.history && t.history.length
        ? '<ul class="hist">' + t.history.slice().reverse().map(function (h) {
            var detail = h.type === "归档" ? esc(h.from) + " → " + esc(h.to) : "修订值 " + esc(h.tension);
            return '<li class="h-' + esc(h.type) + '"><span class="tag tag-' + esc(h.type) + '">' + esc(h.type) + "</span>" + detail
              + " <span class='meta'>v" + (h.paramVersion || "?") + " · " + fmt(h.at) + "</span><div class='meta'>" + esc(h.note) + "</div></li>";
          }).join("") + "</ul>"
        : "";
      var logs = (t.logs || []).slice(-3).map(function (l) { return '<div class="meta">' + fmt(l.at) + " " + esc(l.note) + "</div>"; }).join("");
      return '<div class="task ' + (t.status === "已闭环" ? "closed" : "open") + '">' + head + steps + cur + panel + hist + logs + "</div>";
    }

    function cardHtml(item) {
      var head = '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3>' + esc(item.code) + " · " + esc(item.shipType) + '</h3><span class="pill pill-' + item.status + '">' + item.status + "</span></div>";
      var info = '<div class="infogrid"><div>比例：<b>' + esc(item.scale) + "</b></div><div>交付：<b>" + esc(item.dueDate) + "</b></div>"
        + "<div>桅杆：" + esc(item.mastCount) + "</div><div>材料：" + esc(item.riggingMaterial) + "</div><div>负责：" + esc(item.owner) + '</div><div class="meta">参数版本 v' + item.paramVersion + "</div></div>";
      var paramForm = '<form class="paramform" data-act="params" data-item="' + esc(item.id) + '">'
        + '<div><label style="margin-top:0">比例</label><input name="scale" value="' + esc(item.scale) + '"></div>'
        + '<div><label style="margin-top:0">交付日期</label><input name="dueDate" type="date" value="' + esc(item.dueDate) + '"></div>'
        + '<button class="secondary small">保存参数</button></form>'
        + '<div class="meta">改动比例或交付日期，未闭环任务将重回待检查按新参数重核，旧结论失效但历史可查</div>';
      var tasks = (item.tasks || []).map(function (t) { return taskHtml(item, t); }).join("") || '<div class="meta">暂无索具任务，可从左侧新增（每模型限一项未闭环任务）</div>';
      var logs = (item.logs || []).slice(-4).map(function (l) { return "<div>" + esc(l.step) + "：" + esc(l.note) + ' <span class="meta">' + fmt(l.at) + "</span></div>"; }).join("");
      return '<article class="card">' + head + info + paramForm + tasks + '<div class="logs meta">' + (logs || "暂无记录") + "</div></article>";
    }

    function render() {
      $("#itemSelect").innerHTML = items.map(function (item) {
        var t = item.openTaskId ? item.tasks.find(function (x) { return x.id === item.openTaskId; }) : null;
        return '<option value="' + esc(item.id) + '">' + esc(item.code) + " · " + esc(item.shipType) + (t ? "（未闭环：" + esc(t.position) + "）" : "（可新增任务）") + "</option>";
      }).join("");
      var stats = Object.fromEntries(STAGES.map(function (s) { return [s, 0]; }));
      items.forEach(function (i) { stats[i.status] += 1; });
      $("#stats").innerHTML = STAGES.map(function (s) {
        return '<div class="stat"><span class="meta">' + s + "</span><strong>" + stats[s] + "</strong></div>";
      }).join("");
      var status = $("#statusFilter").value;
      var q = $("#search").value.trim();
      var visible = items.filter(function (item) {
        return (!status || item.status === status) && (!q || JSON.stringify(item).includes(q));
      });
      $("#cards").innerHTML = visible.map(cardHtml).join("");
    }

    async function load() { items = await api("/api/items"); render(); }
    async function run(fn, btn) {
      if (busy) return; busy = true; if (btn) btn.disabled = true;
      try { await fn(); await load(); }
      catch (e) { showMsg(e.message, false); throw e; }
      finally { busy = false; if (btn) btn.disabled = false; }
    }

    $("#createForm").onsubmit = async function (event) {
      event.preventDefault();
      var data = Object.fromEntries(new FormData(this).entries());
      await run(async function () { await api("/api/items", { method: "POST", body: JSON.stringify(data) }); showMsg("模型已建档", true); }, event.submitter);
      $("#createForm").reset();
    };
    $("#taskForm").onsubmit = async function (event) {
      event.preventDefault();
      var data = Object.fromEntries(new FormData(this).entries());
      var id = data.id; delete data.id;
      await run(async function () { await api("/api/items/" + encodeURIComponent(id) + "/tasks", { method: "POST", body: JSON.stringify(data) }); showMsg("索具任务已提交，状态：待检查", true); }, event.submitter);
      $("#taskForm").reset();
    };
    $("#cards").addEventListener("click", async function (event) {
      var btn = event.target.closest("button[data-act]");
      if (!btn) return;
      var itemId = btn.dataset.item, taskId = btn.dataset.task, act = btn.dataset.act;
      if (act === "start") {
        await run(async function () { var r = await postTransition(itemId, taskId, { action: "start" }); showMsg(r.note, true); }, btn);
      } else if (act === "approve") {
        await run(async function () { var r = await postTransition(itemId, taskId, { action: "approve" }); showMsg(r.note, true); }, btn);
      } else if (act === "reject") {
        var note = prompt("驳回原因（原值继续有效，任务退回调整中）") || "";
        await run(async function () { var r = await postTransition(itemId, taskId, { action: "reject", note: note }); showMsg(r.note, true); }, btn);
      }
    });
    $("#cards").addEventListener("submit", async function (event) {
      var formEl = event.target.closest("form[data-act]");
      if (!formEl) return;
      event.preventDefault();
      var itemId = formEl.dataset.item, act = formEl.dataset.act;
      if (act === "adjust") {
        var data = Object.fromEntries(new FormData(formEl).entries());
        data.action = "adjust";
        await run(async function () {
          var r = await postTransition(itemId, formEl.dataset.task, data);
          showMsg(r.reused ? "重复提交，已沿用首次待复核修订" : r.note, true);
        }, formEl.querySelector("button"));
      } else if (act === "params") {
        var pdata = Object.fromEntries(new FormData(formEl).entries());
        var current = items.find(function (x) { return x.id === itemId; });
        var changed = pdata.scale !== current.scale || pdata.dueDate !== current.dueDate;
        if (changed && !confirm("修改比例或交付日期后，未闭环任务将按新参数重核，旧结论失效（历史留存）。是否继续？")) return;
        await run(async function () {
          var r = await api("/api/items/" + encodeURIComponent(itemId), { method: "PATCH", body: JSON.stringify(pdata) });
          showMsg(r.rechecked ? "参数已变更，未闭环任务重回待检查重核" : "参数已保存", true);
        }, formEl.querySelector("button"));
      }
    });
    async function postTransition(itemId, taskId, data) {
      return api("/api/items/" + encodeURIComponent(itemId) + "/tasks/" + encodeURIComponent(taskId) + "/transitions", { method: "POST", body: JSON.stringify(data) });
    }
    $("#statusFilter").onchange = render;
    $("#search").oninput = render;
    $("#reload").onclick = function () { load().then(function () { showMsg("列表已刷新，状态以服务器为准", true); }); };
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
    if (req.method === "GET" && url.pathname === "/api/items") {
      return send(res, 200, db.items.map(summarize));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      return send(res, 200, computeStats(db.items));
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!input.code || !String(input.code).trim()) throw new ApiError(400, "模型编号不能为空");
      const item = {
        id: newId("MR"),
        ...cleanMeta(input),
        paramVersion: 1,
        tasks: [],
        logs: [{ at: now(), step: "建档", note: "创建模型 " + input.code }],
      };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    const oneItem = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (oneItem && req.method === "PATCH") {
      const item = findItem(db, decodeURIComponent(oneItem[1]));
      const result = applyMetaPatch(item, await body(req));
      await saveDb(db);
      return send(res, 200, { ...summarize(item), ...result });
    }
    const tasksPath = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks$/);
    if (tasksPath && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(tasksPath[1]));
      const task = createTask(item, await body(req));
      await saveDb(db);
      return send(res, 201, { ...summarize(item), task });
    }
    const transitionPath = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/transitions$/);
    if (transitionPath && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(transitionPath[1]));
      const task = findTask(item, decodeURIComponent(transitionPath[2]));
      const result = transition(item, task, await body(req));
      await saveDb(db);
      return send(res, 200, { ...summarize(item), ...result });
    }
    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    send(res, error.status || 500, { error: error.name || "server_error", message: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索复核台 listening on http://localhost:" + port));
