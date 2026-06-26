// ═══════════════════════════════════════════════════════════
//  合同管理系统 — Node.js / Express 后端
//  依赖: express, firebase-admin, multer, dotenv, googleapis, mammoth
// ═══════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const express        = require('express');
const admin          = require('firebase-admin');
const multer         = require('multer');
const path           = require('path');
const https          = require('https');
const { google }     = require('googleapis');
const mammoth        = require('mammoth');

// ── Firebase Admin 初始化 ────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:    admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET  // e.g. contract-managementv4.firebasestorage.app
});
const db     = admin.firestore();
const bucket = admin.storage().bucket();

// ── Express 初始化 ───────────────────────────────────────
const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }   // 20 MB
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════
//  API：数据（Firestore）
// ══════════════════════════════════════════════════════════

// GET /api/data — 一次读取所有集合
app.get('/api/data', async (req, res) => {
  try {
    const keys = ['contracts', 'entities', 'templates', 'meta', 'timeline'];
    const docs = await Promise.all(
      keys.map(k => db.collection('cms').doc(k).get())
    );
    const result = {};
    keys.forEach((k, i) => {
      result[k] = docs[i].exists ? (docs[i].data().data ?? []) : getDefault(k);
    });
    res.json(result);
  } catch (e) {
    console.error('GET /api/data error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/data — 批量保存（只传变化的 key 也可以）
app.post('/api/data', async (req, res) => {
  try {
    const allowed = ['contracts', 'entities', 'templates', 'meta', 'timeline'];
    const batch   = db.batch();
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        batch.set(db.collection('cms').doc(k), { data: req.body[k] });
      }
    });
    await batch.commit();
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/data error:', e);
    res.status(500).json({ error: e.message });
  }
});

function getDefault(key) {
  return key === 'meta' ? {} : [];
}

// ══════════════════════════════════════════════════════════
//  API：文件（Firebase Storage）
// ══════════════════════════════════════════════════════════

// POST /api/files/upload  multipart: file + fileId
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
  try {
    const { fileId } = req.body;
    if (!req.file || !fileId) {
      return res.status(400).json({ error: 'Missing file or fileId' });
    }
    const storePath = `files/${fileId}`;
    const fileRef   = bucket.file(storePath);
    await fileRef.save(req.file.buffer, {
      contentType: req.file.mimetype,
      metadata:    { originalName: req.file.originalname }
    });
    // 返回通过本服务器下载的相对 URL（不暴露 Storage 凭证）
    res.json({ url: `/api/files/${fileId}`, name: req.file.originalname });
  } catch (e) {
    console.error('POST /api/files/upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:fileId   下载 / 预览
app.get('/api/files/:fileId', async (req, res) => {
  try {
    const fileRef  = bucket.file(`files/${req.params.fileId}`);
    const [exists] = await fileRef.exists();
    if (!exists) return res.status(404).json({ error: 'File not found' });

    const [meta]   = await fileRef.getMetadata();
    const mimeType = meta.contentType || 'application/octet-stream';
    const origName = meta.metadata?.originalName || req.params.fileId;

    // ?download=1 强制下载；否则内联显示（PDF 可在浏览器预览）
    const disposition = req.query.download === '1'
      ? `attachment; filename="${encodeURIComponent(origName)}"`
      : `inline; filename="${encodeURIComponent(origName)}"`;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    fileRef.createReadStream()
      .on('error', err => { console.error('Stream error:', err); res.status(500).end(); })
      .pipe(res);
  } catch (e) {
    console.error('GET /api/files/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  API：AI 分析（代理 Anthropic，隐藏 API Key）
// ══════════════════════════════════════════════════════════

app.post('/api/ai/analyze', express.json({ limit: '30mb' }), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const body    = JSON.stringify(req.body);
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      }
    };

    const proxyReq = https.request(options, proxyRes => {
      res.status(proxyRes.statusCode);
      res.setHeader('Content-Type', 'application/json');
      proxyRes.pipe(res);
    });
    proxyReq.on('error', e => {
      console.error('Anthropic proxy error:', e);
      res.status(502).json({ error: e.message });
    });
    proxyReq.write(body);
    proxyReq.end();
  } catch (e) {
    console.error('POST /api/ai/analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  Google Drive 扫描
// ══════════════════════════════════════════════════════════

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  return google.drive({ version: 'v3', auth });
}

async function extractWithClaude(fileBuffer, mimeType, fileName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const base64 = Buffer.from(fileBuffer).toString('base64');

  let contentParts = [];

  if (mimeType === 'application/pdf') {
    contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } });
  } else if (mimeType.startsWith('image/')) {
    contentParts.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } });
  } else if (mimeType.includes('wordprocessingml') || mimeType.includes('msword')) {
    // Extract text from DOCX with mammoth
    const result = await mammoth.extractRawText({ buffer: Buffer.from(fileBuffer) });
    const text = result.value.slice(0, 12000); // trim to ~3k tokens
    contentParts.push({ type: 'text', text: `Contract text:\n${text}` });
  } else {
    contentParts.push({ type: 'text', text: `Unable to read file. Filename: "${fileName}". Please extract what you can from the filename only.` });
  }

  contentParts.push({
    type: 'text',
    text: `Filename: "${fileName}"

Analyse this contract and return ONLY a valid JSON object (no markdown, no explanation):
{
  "name": "full contract title",
  "counterparty": "counterparty company name",
  "ourEntity": "our company entity name if mentioned, otherwise null",
  "type": "external or intercompany",
  "contractType": "e.g. Service Agreement, NDA, Employment Contract, Lease",
  "startDate": "YYYY-MM-DD or null",
  "endDate": "YYYY-MM-DD or null",
  "value": number or null,
  "currency": "SGD/USD/CNY/HKD or null",
  "autoRenew": true or false or null,
  "noticePeriod": number of days or null,
  "isSigned": true if the contract has signatures or stamps indicating execution, false if draft,
  "summary": "2-3 sentence summary in the SAME LANGUAGE as the contract",
  "confidence": "high if clearly a contract with full details, medium if partial, low if unclear or not a contract"
}`
  });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: contentParts }]
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const raw = (data.content?.[0]?.text || '{}').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  try { return JSON.parse(raw); }
  catch(e) { return { confidence: 'low', name: fileName, isSigned: false }; }
}

const SUPPORTED_MIME = [
  'application/pdf','image/jpeg','image/png','image/webp','image/gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword','application/vnd.google-apps.document'
];

function makeContractId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2,5); }

// Step 1: list new files only (fast, < 2s)
async function listNewDriveFiles() {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('Missing DRIVE_FOLDER_ID');
  const drive = getDriveClient();

  const listRes = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime)',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  const allFiles = listRes.data.files || [];
  console.log(`Drive list: ${allFiles.length} files in folder ${folderId}`);

  const contractsDoc = await db.collection('cms').doc('contracts').get();
  const contracts = contractsDoc.exists ? (contractsDoc.data().data || []) : [];
  const knownIds = new Set();
  contracts.forEach(c => {
    if (c.driveFileId) knownIds.add(c.driveFileId);
    (c.versions || []).forEach(v => { if (v.driveFileId) knownIds.add(v.driveFileId); });
  });

  const newFiles = allFiles.filter(f => !knownIds.has(f.id) && SUPPORTED_MIME.includes(f.mimeType));
  const skipped  = allFiles.filter(f => !knownIds.has(f.id) && !SUPPORTED_MIME.includes(f.mimeType)).length;
  return { total: allFiles.length, newFiles, skipped };
}

// Step 2: process one file (download + Claude + Firestore save, < 10s)
async function processOneDriveFile(fileId, fileName, mimeType) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
  const drive = getDriveClient();

  let buffer, mime = mimeType;
  if (mime === 'application/vnd.google-apps.document') {
    const r = await drive.files.export({ fileId, mimeType: 'application/pdf', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    buffer = Buffer.from(r.data); mime = 'application/pdf';
  } else {
    const r = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    buffer = Buffer.from(r.data);
  }

  const x = await extractWithClaude(buffer, mime, fileName);

  const contractsDoc = await db.collection('cms').doc('contracts').get();
  const contracts = contractsDoc.exists ? (contractsDoc.data().data || []) : [];

  // Check if already exists (race condition guard)
  const alreadyExists = contracts.some(c =>
    c.driveFileId === fileId || (c.versions || []).some(v => v.driveFileId === fileId)
  );
  if (alreadyExists) return { skipped: true };

  // Try to match to existing contract as a version (same counterparty)
  if (x.isSigned === false && x.confidence !== 'low' && x.counterparty) {
    const cp = x.counterparty.toLowerCase().replace(/\s+/g,'').slice(0,10);
    const existing = contracts.find(c => {
      const ecp = (c.counterparty||'').toLowerCase().replace(/\s+/g,'').slice(0,10);
      return ecp && cp && (ecp.includes(cp.slice(0,6)) || cp.includes(ecp.slice(0,6)));
    });
    if (existing) {
      if (!existing.versions) existing.versions = [];
      existing.versions.push({ driveFileId: fileId, driveFileName: fileName, isSigned: false, scannedAt: new Date().toISOString() });
      await db.collection('cms').doc('contracts').set({ data: contracts });
      return { action: 'version_added', contract: existing.name };
    }
  }

  // New contract record
  const record = {
    id: makeContractId(),
    name: x.name || fileName.replace(/\.[^.]+$/, ''),
    counterparty: x.counterparty || '',
    entity: x.ourEntity || '',
    type: x.type === 'intercompany' ? 'intercompany' : 'external',
    contractType: x.contractType || '',
    startDate: x.startDate || '',
    endDate: x.endDate || '',
    value: x.value || null,
    currency: x.currency || 'SGD',
    autoRenew: x.autoRenew || false,
    noticePeriod: x.noticePeriod || null,
    status: x.isSigned === false ? 'reviewing' : 'active',
    notes: x.summary || '',
    driveFileId: fileId,
    driveFileName: fileName,
    driveScannedAt: new Date().toISOString(),
    aiConfidence: x.confidence || 'medium',
    versions: [],
    createdAt: new Date().toISOString()
  };

  await db.collection('cms').doc('contracts').set({ data: [...contracts, record] });
  return { action: 'added', name: record.name, status: record.status, confidence: x.confidence };
}

// GET /api/claude/test — test Claude API key
app.get('/api/claude/test', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key': apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:20, messages:[{role:'user',content:'Reply with OK only.'}] })
    });
    const data = await r.json();
    res.json({ httpStatus: r.status, data });
  } catch(e) { res.json({ ok:false, error: e.message }); }
});

// GET /api/drive/debug — diagnose Drive access
app.get('/api/drive/debug', async (req, res) => {
  try {
    const folderId = process.env.DRIVE_FOLDER_ID;
    const drive = getDriveClient();

    // Try to get folder metadata
    let folderInfo = null;
    try {
      const f = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType', supportsAllDrives: true });
      folderInfo = f.data;
    } catch(e) { folderInfo = { error: e.message }; }

    // Try to list files
    let files = [], listError = null;
    try {
      const r = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id,name,mimeType)',
        pageSize: 20,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      files = r.data.files || [];
    } catch(e) { listError = e.message; }

    res.json({ folderId, folderInfo, fileCount: files.length, files: files.slice(0,10), listError });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/drive/scan — Step 1: list new files only (fast < 2s)
app.post('/api/drive/scan', async (req, res) => {
  try {
    const { total, newFiles, skipped } = await listNewDriveFiles();
    res.json({ ok: true, total, newFiles, skipped });
  } catch(e) {
    console.error('Drive list error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/drive/process — Step 2: process one file (< 10s)
app.post('/api/drive/process', async (req, res) => {
  try {
    const { fileId, fileName, mimeType } = req.body;
    if (!fileId || !fileName) return res.status(400).json({ error: 'Missing fileId or fileName' });
    const result = await processOneDriveFile(fileId, fileName, mimeType);
    res.json({ ok: true, ...result });
  } catch(e) {
    console.error('Drive process error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/drive/status — last scan log
app.get('/api/drive/status', async (req, res) => {
  try {
    const doc = await db.collection('cms').doc('scanLog').get();
    res.json(doc.exists ? doc.data() : { lastScan: null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/drive/cron-scan — called by Vercel cron (daily): list + process all one by one
app.get('/api/drive/cron-scan', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const { newFiles, skipped } = await listNewDriveFiles();
    const results = { added: 0, reviewing: 0, errors: 0 };
    for (const f of newFiles) {
      try {
        const r = await processOneDriveFile(f.id, f.name, f.mimeType);
        if (r.action === 'added') { if (r.status === 'active') results.added++; else results.reviewing++; }
      } catch(e) { results.errors++; console.error('Cron process error:', f.name, e.message); }
    }
    // Save scan log
    await db.collection('cms').doc('scanLog').set({
      lastScan: new Date().toISOString(), ...results, skipped, newFiles: newFiles.length
    });
    res.json({ ok: true, ...results, skipped });
  } catch(e) {
    console.error('Cron scan error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 启动 ─────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ 合同管理系统运行中：http://localhost:${PORT}`);
  });
}
module.exports = app;
