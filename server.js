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

async function runDriveScan() {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId || !process.env.ANTHROPIC_API_KEY) throw new Error('Missing env vars');

  const drive = getDriveClient();

  // 1. List all files in Drive folder
  const listRes = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    pageSize: 200
  });
  const allFiles = listRes.data.files || [];

  // 2. Get existing contract driveFileIds from Firestore
  const contractsDoc = await db.collection('cms').doc('contracts').get();
  const contracts = contractsDoc.exists ? (contractsDoc.data().data || []) : [];

  const knownIds = new Set();
  contracts.forEach(c => {
    if (c.driveFileId) knownIds.add(c.driveFileId);
    (c.versions || []).forEach(v => { if (v.driveFileId) knownIds.add(v.driveFileId); });
  });

  // 3. Separate new vs known files
  const SUPPORTED = ['application/pdf','image/jpeg','image/png','image/webp','image/gif',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword','application/vnd.google-apps.document'];
  const newFiles   = allFiles.filter(f => !knownIds.has(f.id) && SUPPORTED.includes(f.mimeType));
  const skipped    = allFiles.filter(f => !knownIds.has(f.id) && !SUPPORTED.includes(f.mimeType)).length;

  if (newFiles.length === 0) {
    return { total: allFiles.length, newFiles: 0, added: 0, drafts: 0, errors: [], skipped };
  }

  // 4. Download + extract each new file
  const processed = [];
  const errors    = [];

  for (const file of newFiles) {
    try {
      let buffer, mime = file.mimeType;

      if (mime === 'application/vnd.google-apps.document') {
        // Native Google Doc → export as PDF
        const r = await drive.files.export({ fileId: file.id, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
        buffer = Buffer.from(r.data); mime = 'application/pdf';
      } else {
        const r = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
        buffer = Buffer.from(r.data);
      }

      const extracted = await extractWithClaude(buffer, mime, file.name);
      processed.push({ file, extracted });
    } catch(err) {
      errors.push({ file: file.name, error: err.message });
    }
    await new Promise(r => setTimeout(r, 400)); // rate-limit buffer
  }

  // 5. Build contract records
  // Separate signed vs draft
  const signed = processed.filter(p => p.extracted.isSigned !== false || p.extracted.confidence === 'low');
  const drafts = processed.filter(p => p.extracted.isSigned === false && p.extracted.confidence !== 'low');

  function makeId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2,5); }

  function buildRecord(p, status, versions=[]) {
    const x = p.extracted;
    return {
      id: makeId(),
      name: x.name || p.file.name.replace(/\.[^.]+$/, ''),
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
      status,
      notes: x.summary || '',
      driveFileId: p.file.id,
      driveFileName: p.file.name,
      driveScannedAt: new Date().toISOString(),
      aiConfidence: x.confidence || 'medium',
      versions,
      createdAt: new Date().toISOString()
    };
  }

  const newRecords = [];

  // For each signed file, find matching drafts (same counterparty prefix)
  const matchedDraftIds = new Set();
  for (const s of signed) {
    const cp = (s.extracted.counterparty || '').toLowerCase().replace(/\s+/g,'').slice(0,10);
    const matchingDrafts = cp ? drafts.filter(d => {
      if (matchedDraftIds.has(d.file.id)) return false;
      const dcp = (d.extracted.counterparty || '').toLowerCase().replace(/\s+/g,'').slice(0,10);
      return cp && dcp && (cp.includes(dcp.slice(0,6)) || dcp.includes(cp.slice(0,6)));
    }) : [];

    const versions = matchingDrafts.map(d => {
      matchedDraftIds.add(d.file.id);
      return { driveFileId: d.file.id, driveFileName: d.file.name, isSigned: false, scannedAt: new Date().toISOString() };
    });

    newRecords.push(buildRecord(s, 'active', versions));
  }

  // Unmatched drafts → reviewing status
  for (const d of drafts) {
    if (!matchedDraftIds.has(d.file.id)) {
      newRecords.push(buildRecord(d, 'reviewing', []));
    }
  }

  // 6. Save to Firestore
  if (newRecords.length > 0) {
    await db.collection('cms').doc('contracts').set({ data: [...contracts, ...newRecords] });
  }

  const scanLog = {
    lastScan: new Date().toISOString(),
    total: allFiles.length, newFiles: newFiles.length,
    added: signed.length, drafts: drafts.filter(d => !matchedDraftIds.has(d.file.id)).length,
    errors: errors.length, skipped
  };
  await db.collection('cms').doc('scanLog').set(scanLog);

  return { ...scanLog, errorDetails: errors };
}

// POST /api/drive/scan — manual trigger from frontend
app.post('/api/drive/scan', async (req, res) => {
  try {
    const result = await runDriveScan();
    res.json({ ok: true, ...result });
  } catch(e) {
    console.error('Drive scan error:', e);
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

// GET /api/drive/cron-scan — called by Vercel cron (daily)
app.get('/api/drive/cron-scan', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const result = await runDriveScan();
    console.log('Cron scan result:', result);
    res.json({ ok: true, ...result });
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
