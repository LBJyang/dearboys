// 聚焦版：只做"判作业"。流程 = 前沿模型批改 → 存结构化数据 → 算趋势 → LLM 解读进步/退步。
// API key 只存在于服务端 .env，不进前端。
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- 读取 .env（避免引入依赖）---
(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      // 云平台已注入的环境变量优先，不被本地 .env 覆盖
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  } catch {}
})();
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PORT = process.env.PORT || 5173;

// --- 存储层：Postgres（持久化）或本地文件，见 storage.js ---
const storage = require("./storage");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// --- 批改提示词：内置防幻觉策略 + 全题打知识点标签 ---
function gradePrompt({ subject, grade, age, country, notes }) {
  return `你是一位资深的中小学${subject || ""}老师兼教研员，批改要严谨、口径统一。
学生：年级=${grade || "未知"}，年龄=${age || "未知"}，国籍=${country || "未知"}。家长补充：${notes || "无"}。

批改步骤（务必遵守，降低误判）：
1. 先逐题"无视学生答案"独立算出/写出标准正确答案。
2. 再识别学生的实际作答。
3. 最后两者比对得出对错。客观题以你独立算出的答案为准。

知识点标签要使用规范、稳定的课标口径（如"20以内进位加法""退位减法""一位数乘法"），同一类错误每次用同一个名称，方便长期统计。

只输出 JSON（不要 markdown、不要多余文字）：
{
  "subject": "识别到的学科",
  "total": 整数, "correct": 整数, "wrong": 整数,
  "score": "如 85/100",
  "questions": [
    {"no":"题号","student_answer":"学生作答","correct_answer":"标准答案","is_correct":true/false,
     "knowledge_point":"规范知识点名（对错题都要填）",
     "error_type":"错题才填：计算错误/概念不清/审题失误/书写/其它",
     "explanation":"错题才填：面向家长的简短讲解"}
  ],
  "knowledge_gaps": ["本次暴露的薄弱知识点"],
  "remediation": ["针对性、可操作的弥补建议"]
}
若照片看不清或非作业，total 填 0 并在 remediation 说明原因。`;
}

// --- 趋势解读提示词 ---
function trendPrompt(child, statsText) {
  return `你是一位负责跟踪学生长期表现的班主任。下面是${child.name || "该学生"}（${child.grade || ""}）一段时间的作业数据统计。
请判断整体是进步还是退步，找出具体的退步/进步点及可能原因，并给出下一步建议。
重要：某个知识点如果标注了"无数据/未涉及"，说明那次作业没考到它，绝不能据此判定为退步或进步，只能说数据不足。

数据：
${statsText}

只输出 JSON：
{
  "verdict": "进步" 或 "退步" 或 "基本持平",
  "overall": "对整体走势的一句话总结",
  "by_point": [{"point":"知识点","trend":"进步/退步/稳定","detail":"具体变化，如正确率从X到Y"}],
  "reasons": ["对退步或进步原因的分析推测"],
  "suggestions": ["接下来一两周的具体建议"]
}`;
}

function callGemini(parts, model = MODEL) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }),
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
    return JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
  });
}

// --- 视频批改提示词（多页、去重）---
function videoGradePrompt({ subject, grade, age, country, notes }) {
  return `这是一段家长翻拍孩子作业的视频，可能出现多页【不同】的作业。学生：年级=${grade || "未知"}，年龄=${age || "未知"}，国籍=${country || "未知"}。学科=${subject || "未知"}。家长补充：${notes || "无"}。

要求：
1. 识别视频中出现了几页【不同】的作业（同一页在多帧重复出现算一页，务必去重）。
2. 对每页逐题批改。批改时先无视学生答案独立算出标准答案，再读学生作答，最后比对。
3. 知识点用规范、稳定的课标口径命名，方便长期统计。
4. 若某页画面太糊看不清，在该页 remediation 里说明"画面不清，建议重拍"。

只输出 JSON（不要 markdown）：
{
  "pages_detected": 整数,
  "pages": [
    {"page": 页序号, "subject": "学科", "total": 整数, "correct": 整数, "wrong": 整数, "score": "如 5/8",
     "questions": [{"no":"题号","student_answer":"作答","correct_answer":"标准答案","is_correct":true/false,"knowledge_point":"规范知识点名","error_type":"错题才填","explanation":"错题才填,面向家长"}],
     "knowledge_gaps": ["薄弱知识点"], "remediation": ["弥补建议"]}
  ]
}`;
}

// --- Files API：上传视频 → 等处理完 → 返回 file_uri ---
async function uploadVideoToGemini(buffer, mimeType) {
  const up = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`, {
    method: "POST",
    headers: { "X-Goog-Upload-Protocol": "raw", "X-Goog-Upload-File-Name": "homework", "Content-Type": mimeType || "video/mp4" },
    body: buffer,
  });
  const data = await up.json();
  if (!up.ok || !data.file) throw new Error(data?.error?.message || "视频上传失败");
  let file = data.file;
  // 轮询直到 ACTIVE（视频需要服务端处理）
  for (let i = 0; i < 30 && file.state !== "ACTIVE"; i++) {
    if (file.state === "FAILED") throw new Error("视频处理失败");
    await new Promise((r) => setTimeout(r, 1500));
    file = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${API_KEY}`)).json();
  }
  if (file.state !== "ACTIVE") throw new Error("视频处理超时");
  return { uri: file.uri, name: file.name };
}
async function deleteGeminiFile(name) {
  try { await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${API_KEY}`, { method: "DELETE" }); } catch {}
}
function callGeminiVideo(promptText, fileUri, mimeType) {
  return callGeminiParts([{ text: promptText }, { file_data: { mime_type: mimeType || "video/mp4", file_uri: fileUri } }]);
}
function callGeminiParts(parts) { return callGemini(parts); }

// --- 从历史记录计算趋势统计（纯代码，不靠模型）---
function computeStats(records) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const scoreSeries = sorted.map((r) => ({ date: r.date.slice(0, 10), correct: r.correct, total: r.total, rate: r.total ? Math.round((r.correct / r.total) * 100) : null }));
  // 把所有记录按时间二分：早期 vs 近期，比较每个知识点正确率
  const half = Math.floor(sorted.length / 2);
  const buckets = { early: sorted.slice(0, half || 1), recent: sorted.slice(half) };
  function pointRates(recs) {
    const m = {};
    for (const r of recs) for (const q of r.questions || []) {
      const k = q.knowledge_point; if (!k) continue;
      m[k] = m[k] || { c: 0, n: 0 };
      m[k].n++; if (q.is_correct) m[k].c++;
    }
    return m;
  }
  const e = pointRates(buckets.early), n = pointRates(buckets.recent);
  const points = [...new Set([...Object.keys(e), ...Object.keys(n)])].map((k) => ({
    point: k,
    early: e[k] ? Math.round((e[k].c / e[k].n) * 100) : null,
    recent: n[k] ? Math.round((n[k].c / n[k].n) * 100) : null,
  }));
  return { count: sorted.length, scoreSeries, points };
}
function statsToText(stats) {
  let t = `共 ${stats.count} 次作业。\n总体正确率序列(按时间)：` +
    stats.scoreSeries.map((s) => `${s.date}=${s.rate}%`).join(", ") + "\n各知识点 早期→近期 正确率：\n";
  for (const p of stats.points) {
    // 只有两期都有数据才算"趋势"；某期无数据要明确标注，避免被误读为退步
    if (p.early == null || p.recent == null) {
      const which = p.early == null ? "早期未涉及" : "近期未涉及";
      t += `- ${p.point}: ${p.early ?? "无数据"}% → ${p.recent ?? "无数据"}%（${which}，数据不足以判断趋势，请勿当作退步/进步）\n`;
    } else {
      t += `- ${p.point}: ${p.early}% → ${p.recent}%\n`;
    }
  }
  return t;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 90e6) reject(new Error("文件过大(>60MB)，请录短一点")); });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    }
    // 静态资源（PWA 清单 + 图标），供"添加到主屏幕"用
    if (req.method === "GET" && (u.pathname === "/manifest.json" || u.pathname.startsWith("/icons/"))) {
      const fp = path.join(__dirname, "public", u.pathname);
      if (fs.existsSync(fp)) {
        const ct = u.pathname.endsWith(".json") ? "application/manifest+json" : "image/png";
        res.writeHead(200, { "Content-Type": ct });
        return res.end(fs.readFileSync(fp));
      }
    }

    // 健康检查：报告存储模式、模型、key 是否配置（用于确认线上配置）
    if (req.method === "GET" && u.pathname === "/api/health") {
      return json(res, 200, { ok: true, storage: storage.getMode(), model: MODEL, hasKey: !!API_KEY });
    }

    // 孩子档案
    if (req.method === "GET" && u.pathname === "/api/children") {
      return json(res, 200, { ok: true, children: await storage.getChildren() });
    }
    if (req.method === "POST" && u.pathname === "/api/children") {
      const meta = JSON.parse(await readBody(req));
      const child = { id: uid(), name: meta.name || "孩子", grade: meta.grade || "", age: meta.age || "", country: meta.country || "" };
      await storage.addChild(child);
      return json(res, 200, { ok: true, child });
    }
    if (req.method === "POST" && u.pathname === "/api/children/update") {
      const { id, name, grade, age, country } = JSON.parse(await readBody(req));
      if (!id) throw new Error("缺少 id");
      const child = await storage.updateChild(id, { name, grade, age, country });
      if (!child) throw new Error("孩子不存在");
      return json(res, 200, { ok: true, child });
    }
    if (req.method === "POST" && u.pathname === "/api/children/delete") {
      const { id } = JSON.parse(await readBody(req));
      if (!id) throw new Error("缺少 id");
      await storage.deleteChild(id);
      return json(res, 200, { ok: true });
    }

    // 批改 + 存档
    if (req.method === "POST" && u.pathname === "/api/grade") {
      if (!API_KEY) throw new Error("未配置 GEMINI_API_KEY，请编辑 .env");
      const { childId, image, mimeType, subject, notes } = JSON.parse(await readBody(req));
      const child = await storage.getChild(childId);
      if (!child) throw new Error("请先选择或创建孩子");
      const parts = [{ text: gradePrompt({ subject, notes, grade: child.grade, age: child.age, country: child.country }) }];
      if (image) parts.push({ inline_data: { mime_type: mimeType || "image/jpeg", data: image } });
      const result = await callGemini(parts);
      const record = { id: uid(), childId, date: new Date().toISOString(), subject: result.subject || subject || "", ...result };
      await storage.addRecord(record);
      return json(res, 200, { ok: true, result, recordId: record.id });
    }

    // 视频批改：上传 → 分页批改 → 每页存一条记录
    if (req.method === "POST" && u.pathname === "/api/grade-video") {
      if (!API_KEY) throw new Error("未配置 GEMINI_API_KEY");
      const { childId, video, mimeType, subject, notes } = JSON.parse(await readBody(req));
      const child = await storage.getChild(childId);
      if (!child) throw new Error("请先选择或创建孩子");
      if (!video) throw new Error("没有收到视频");
      const buffer = Buffer.from(video, "base64");
      const file = await uploadVideoToGemini(buffer, mimeType);
      try {
        const result = await callGeminiVideo(
          videoGradePrompt({ subject, notes, grade: child.grade, age: child.age, country: child.country }),
          file.uri, mimeType
        );
        // 每页存为一条记录，进入趋势
        const now = new Date();
        for (let i = 0; i < (result.pages || []).length; i++) {
          const p = result.pages[i];
          await storage.addRecord({
            id: uid(), childId,
            date: new Date(now.getTime() + i).toISOString(),
            subject: p.subject || subject || "",
            source: "video", page: p.page ?? i + 1,
            total: p.total, correct: p.correct, wrong: p.wrong, score: p.score,
            questions: p.questions || [], knowledge_gaps: p.knowledge_gaps || [], remediation: p.remediation || [],
          });
        }
        return json(res, 200, { ok: true, result });
      } finally {
        deleteGeminiFile(file.name); // 用完即删，减少留存
      }
    }

    // 历史 + 趋势统计（代码算）
    if (req.method === "GET" && u.pathname === "/api/history") {
      const childId = u.searchParams.get("childId");
      const recs = await storage.getRecords(childId);
      return json(res, 200, { ok: true, records: recs, stats: computeStats(recs) });
    }

    // 趋势解读（LLM 生成人话）
    if (req.method === "GET" && u.pathname === "/api/trend") {
      if (!API_KEY) throw new Error("未配置 GEMINI_API_KEY");
      const childId = u.searchParams.get("childId");
      const recs = await storage.getRecords(childId);
      if (recs.length < 2) return json(res, 200, { ok: true, trend: null, note: "至少需要 2 次作业才能分析趋势" });
      const stats = computeStats(recs);
      const child = await storage.getChild(childId);
      const trend = await callGemini([{ text: trendPrompt(child || {}, statsToText(stats)) }]);
      return json(res, 200, { ok: true, trend, stats });
    }

    res.writeHead(404); res.end("Not found");
  } catch (e) {
    json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`\n  ✅ 判作业原型(聚焦版)：http://localhost:${PORT}`);
  console.log(`  模型：${MODEL}`);
  console.log(`  API key：${API_KEY ? API_KEY.slice(0, 8) + "…" : "❌ 未配置"}`);
  try { await storage.initStorage(); } catch (e) { console.error("  ⚠️ 存储初始化失败：", e.message); }
  console.log("");
});
