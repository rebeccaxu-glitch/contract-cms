// ═══════════════════════════════════════════════════════════
//  合同管理系统 — Node.js / Express 后端
//  依赖: express, firebase-admin, multer, dotenv
// ═══════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const express  = require('express');
const admin    = require('firebase-admin');
const multer   = require('multer');
const path     = require('path');
const https    = require('https');

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

// ── 启动 ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 合同管理系统运行中: http://localhost:${PORT}`);
});
module.exports = app;
