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
//  实体注册表 & Brand 解析
// ══════════════════════════════════════════════════════════

// All known entities across all brands.
// coreWords: normalized keywords that uniquely identify this entity (order matters — more specific first)
// jurisdictionAliases: required when multiple entities share the same name (e.g. Anzo Capital Limited BZ vs KE)
// disambiguate: optional pipe-separated terms to pick between entities sharing the same coreWords
const ENTITY_REGISTRY = [
  // ── Orbitlabs ──────────────────────────────────────────
  { brand:'orbitlabs', name:'Orbitlabs Pte. Ltd.',               flag:'🇸🇬', coreWords:['orbitlabs'] },
  { brand:'orbitlabs', name:'深圳市星轨实验科技有限公司',            flag:'🇨🇳', coreWords:['星轨实验','星轨','xinggui'] },
  { brand:'orbitlabs', name:'星應有限公司',                         flag:'🇹🇼', coreWords:['星應','xing ying','xingying'] },
  { brand:'orbitlabs', name:'Orbitlabs Services Aust',            flag:'🇦🇺', coreWords:['orbitlabs'], disambiguate:'aust|australia' },

  // ── Techntea ───────────────────────────────────────────
  { brand:'techntea',  name:'Techntea Pte. Ltd.',                 flag:'🇸🇬', coreWords:['techntea'] },

  // ── Anzo ──────────────────────────────────────────────
  { brand:'anzo', name:'Anzo Holding Limited',                    flag:'🇭🇰', coreWords:['anzo holding'] },
  { brand:'anzo', name:'Anzo Capital (Int.) Pty Ltd',             flag:'🇲🇺', coreWords:['anzo capital'], disambiguate:'int|mauritius|mu' },
  { brand:'anzo', name:'Anzo Capital (Aust) Pty Ltd',             flag:'🇦🇺', coreWords:['anzo capital'], disambiguate:'aust|australia' },
  { brand:'anzo', name:'Anzo Capital (SVG) LLC',                  flag:'🏳️',  coreWords:['anzo capital'], disambiguate:'svg|vincent|grenadines' },
  { brand:'anzo', name:'ANZO CAPITAL GLOBAL LIMITED',             flag:'🇻🇺', coreWords:['anzo capital global','anzocapital global'] },
  { brand:'anzo', name:'ANZOCAP NIGERIA LIMITED',                 flag:'🇳🇬', coreWords:['anzocap','anzo nigeria'] },
  // Same name, different jurisdiction — require jurisdiction match
  { brand:'anzo', name:'Anzo Capital Limited (BZ)',               flag:'🇧🇿', coreWords:['anzo capital limited'], jurisdictionAliases:['belize','bz','belizean'] },
  { brand:'anzo', name:'Anzo Capital Limited (KE)',               flag:'🇰🇪', coreWords:['anzo capital limited'], jurisdictionAliases:['kenya','ke','kenyan','nairobi'] },

  // ── DLSM ──────────────────────────────────────────────
  { brand:'dlsm', name:'DLS Markets Limited',                     flag:'🇻🇺', coreWords:['dls markets'] },
  { brand:'dlsm', name:'DLS Markets (International) Pty Ltd',     flag:'🇰🇾', coreWords:['dls markets'], disambiguate:'international|cayman|ky' },
  { brand:'dlsm', name:'DLS Markets (Aust) Pty Ltd',              flag:'🇦🇺', coreWords:['dls markets'], disambiguate:'aust|australia' },
  { brand:'dlsm', name:'Long Leading Services Sdn. Bhd.',         flag:'🇲🇾', coreWords:['long leading'], disambiguate:'sdn|bhd|malaysia|my' },
  { brand:'dlsm', name:'LONG LEADING SERVICES PTY LTD',          flag:'🇦🇺', coreWords:['long leading'], disambiguate:'pty|aust|australia' },

  // ── TTG ───────────────────────────────────────────────
  { brand:'ttg', name:'ThreeTrader Global (MU) Pty Ltd',          flag:'🇲🇺', coreWords:['threetrader global','three trader global'], disambiguate:'mu|mauritius' },
  { brand:'ttg', name:'ThreeTrader Global Limited',               flag:'🇻🇺', coreWords:['threetrader global','three trader global'] },
  { brand:'ttg', name:'THREETRADER (V) LIMITED',                  flag:'🇻🇺', coreWords:['threetrader','three trader'], disambiguate:'vanuatu|vu' },
  { brand:'ttg', name:'ThreeTrader Limited',                      flag:'🇻🇬', coreWords:['threetrader','three trader'] },
  { brand:'ttg', name:'TTG HOLDING (SG) Pte. Ltd.',               flag:'🇸🇬', coreWords:['ttg holding','ttg'] },
  { brand:'ttg', name:'TTG AU PTY LTD',                           flag:'🇦🇺', coreWords:['ttg'], disambiguate:'au|aust|australia' },
  { brand:'ttg', name:'Lian Mei Global Company Limited',          flag:'🇹🇼', coreWords:['lian mei','联美','lianmei'] },

  // ── Oqtima ────────────────────────────────────────────
  { brand:'oqtima', name:'OQTIMA GLOBAL LIMITED',                 flag:'🇭🇰', coreWords:['oqtima global','oqtima'] },
  { brand:'oqtima', name:'Oqtima Int. Ltd',                       flag:'🇸🇨', coreWords:['oqtima'] },
  { brand:'oqtima', name:'Ipso Facto Ltd',                        flag:'🇨🇾', coreWords:['ipso facto'] },
  { brand:'oqtima', name:'AD Maiora Holding Limited',             flag:'🇨🇾', coreWords:['ad maiora','admaiora'] },
  { brand:'oqtima', name:'PLATICA SERVICES LIMITED',              flag:'🇨🇾', coreWords:['platica'] },

  // ── Lime Up ───────────────────────────────────────────
  { brand:'limeup', name:'Next Mango Pte. Ltd.',                  flag:'🇸🇬', coreWords:['next mango','nextmango'] },
  { brand:'limeup', name:'Lime Up Services',                      flag:'🌐',  coreWords:['lime up','limeup'] },

  // ── Paypaz ────────────────────────────────────────────
  { brand:'paypaz', name:'Magic Papaya Pte. Ltd.',                flag:'🇸🇬', coreWords:['magic papaya','magicpapaya','paypaz'] },
];

// Normalize a string for matching: lowercase, strip punctuation/common suffixes, collapse spaces
function normStr(s) {
  return (s || '').toLowerCase()
    .replace(/[.,()[\]_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolve entity name + optional jurisdiction → { brand, entity } or null
function resolveEntityInfo(entityName, jurisdiction) {
  if (!entityName || !entityName.trim()) return null;
  const ni = normStr(entityName);
  const nj = normStr(jurisdiction || '');

  let bestMatch = null, bestScore = 0;

  for (const ent of ENTITY_REGISTRY) {
    // 1. Check core word match (first match wins for same score)
    const cw = ent.coreWords.find(w => ni.includes(normStr(w)));
    if (!cw) continue;
    let score = cw.length; // longer match = more specific

    // 2. Jurisdiction is REQUIRED for entries with jurisdictionAliases
    if (ent.jurisdictionAliases) {
      const jurisHit = ent.jurisdictionAliases.some(a => ni.includes(a) || nj.includes(a));
      if (!jurisHit) continue;
      score += 20;
    }

    // 3. Disambiguation bonus (not required, just boosts score)
    if (ent.disambiguate) {
      const terms = ent.disambiguate.split('|');
      if (terms.some(t => ni.includes(t) || nj.includes(t))) score += 10;
    }

    if (score > bestScore) { bestScore = score; bestMatch = ent; }
  }

  if (!bestMatch) return null;
  return { brand: bestMatch.brand, entity: bestMatch.name };
}

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
    contentParts.push({ type: 'text', text: `Unable to read file content. Filename: "${fileName}". Return null for all date fields — do not guess dates from the filename.` });
  }

  const fileHint = hasSignedKeyword(fileName)
    ? 'Note: the filename suggests this may be a signed/executed copy.'
    : '';

  contentParts.push({
    type: 'text',
    text: `Filename: "${fileName}"
${fileHint}

Analyse this contract and return ONLY a valid JSON object (no markdown, no explanation):
{
  "name": "full contract title",
  "counterparty": "counterparty company full legal name exactly as written",
  "counterpartyJurisdiction": "counterparty country/jurisdiction of incorporation (2-letter ISO code preferred, e.g. SG, CN, HK, AU, BZ, KE, VU, MU, CY, SC, BVI, MY, TW) or null",
  "ourEntity": "our company entity full legal name exactly as written, or null",
  "ourEntityJurisdiction": "our entity country/jurisdiction of incorporation (2-letter ISO code preferred) or null",
  "type": "external or intercompany",
  "contractType": "e.g. Service Agreement, NDA, Employment Contract, Lease, Loan Agreement",
  "startDate": "YYYY-MM-DD — extract from the contract body (signing date, effective date, or commencement date as stated in the document). Do NOT infer from the filename. Return null if no date is found in the document.",
  "endDate": "YYYY-MM-DD — extract from the contract body (expiry or termination date as stated in the document). Do NOT infer from the filename. Return null if not found.",
  "value": number or null,
  "currency": "SGD/USD/CNY/HKD/AUD or null",
  "autoRenew": true or false or null,
  "noticePeriod": number of days or null,
  "isSigned": true if the contract shows actual signatures (handwritten or digital), company chops/stamps, or execution markings from BOTH parties — false if it is a draft with no signatures,
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

function makeContractId(dateStr, existingContracts) {
  let d;
  if (dateStr) {
    d = dateStr.replace(/-/g, '');
  } else {
    const n = new Date();
    d = String(n.getFullYear()) + String(n.getMonth()+1).padStart(2,'0') + String(n.getDate()).padStart(2,'0');
  }
  const count = (existingContracts || []).filter(c => c.id && c.id.startsWith(d)).length;
  return d + String(count + 1).padStart(2, '0');
}

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

// Detect signed contract from filename (double-check alongside Claude's content analysis)
function hasSignedKeyword(fileName) {
  return /signed|final|executed|countersigned|_sign[_\-\s]|签署[版稿]?|盖章|签字版|execution\s*copy/i.test(fileName || '');
}

// Fuzzy counterparty match (first 8 normalised chars overlap)
function cpMatch(a, b) {
  if (!a || !b) return false;
  const na = a.toLowerCase().replace(/[\s.,()]/g,'').slice(0,8);
  const nb = b.toLowerCase().replace(/[\s.,()]/g,'').slice(0,8);
  return na.length >= 4 && nb.length >= 4 && (na.includes(nb.slice(0,6)) || nb.includes(na.slice(0,6)));
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

  // Combine Claude's content analysis with filename hint for better accuracy
  const filenameSuggestsSigned = hasSignedKeyword(fileName);
  // Treat as signed if: Claude says signed, OR filename strongly suggests signed
  // Treat as draft if: Claude says draft AND filename has no signed keyword
  const isSigned = x.isSigned !== false || filenameSuggestsSigned;
  x.isSigned = isSigned; // normalise

  const contractsDoc = await db.collection('cms').doc('contracts').get();
  const contracts = contractsDoc.exists ? (contractsDoc.data().data || []) : [];

  // Check if already exists (race condition guard)
  const alreadyExists = contracts.some(c =>
    c.driveFileId === fileId || (c.versions || []).some(v => v.driveFileId === fileId)
  );
  if (alreadyExists) return { skipped: true };

  const counterpartyFromExtract = x.counterparty || '';

  // ── Case A: NEW FILE IS SIGNED → check if an existing 'reviewing' contract matches ──
  // If so, upgrade it: add signed file as final version, set status → active
  if (isSigned && x.confidence !== 'low' && counterpartyFromExtract) {
    const existing = contracts.find(c =>
      c.status === 'reviewing' &&
      cpMatch(c.party || c.counterparty, counterpartyFromExtract)
    );
    if (existing) {
      if (!existing.versions) existing.versions = [];
      existing.versions.push({
        id: 'v' + Date.now(),
        type: 'final',
        driveFileId: fileId,
        driveFileName: fileName,
        fileName: fileName,
        isSigned: true,
        scannedAt: new Date().toISOString(),
        note: filenameSuggestsSigned ? '签署版（文件名识别）' : '签署版（AI 内容识别）'
      });
      existing.status = 'active';
      existing.hasSigned = true;
      await db.collection('cms').doc('contracts').set({ data: contracts });
      return { action: 'upgraded', name: existing.name, contract: existing.name };
    }
  }

  // ── Case B: NEW FILE IS DRAFT → add as draft version to matching existing contract ──
  if (!isSigned && x.confidence !== 'low' && counterpartyFromExtract) {
    const existing = contracts.find(c =>
      cpMatch(c.party || c.counterparty, counterpartyFromExtract)
    );
    if (existing) {
      if (!existing.versions) existing.versions = [];
      existing.versions.push({
        id: 'v' + Date.now(),
        type: 'draft',
        driveFileId: fileId,
        driveFileName: fileName,
        fileName: fileName,
        isSigned: false,
        scannedAt: new Date().toISOString(),
        note: '草稿（Drive 导入）'
      });
      await db.collection('cms').doc('contracts').set({ data: contracts });
      return { action: 'version_added', contract: existing.name };
    }
  }

  // Resolve brand + entity using registry
  const resolved = resolveEntityInfo(x.ourEntity, x.ourEntityJurisdiction)
    || resolveEntityInfo(x.counterparty, x.counterpartyJurisdiction);

  // New contract record — field names match frontend expectations
  const record = {
    id: makeContractId(x.startDate, contracts),
    name: x.name || fileName.replace(/\.[^.]+$/, ''),
    party: x.counterparty || '',          // frontend reads c.party
    entity: (resolved && resolved.entity) || x.ourEntity || '',
    brand: (resolved && resolved.brand) || null,
    isIntercompany: x.type === 'intercompany',
    type: x.contractType || '',           // frontend shows c.type as contract type label
    start: x.startDate || '',
    end: x.endDate || '',
    fees: x.value ? String(x.value) : '',
    currency: x.currency || 'SGD',
    autoRenewal: x.autoRenew || false,
    noticePeriod: x.noticePeriod || null,
    noticePeriodUnit: 'days',
    status: x.isSigned === false ? 'reviewing' : 'active',
    notes: x.summary || '',
    driveFileId: fileId,
    driveFileName: fileName,
    driveScannedAt: new Date().toISOString(),
    aiConfidence: x.confidence || 'medium',
    brandResolved: !!(resolved),
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

// GET /api/drive/list-all — list all files in Drive folder, marking which are already imported
app.get('/api/drive/list-all', async (req, res) => {
  try {
    const folderId = process.env.DRIVE_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'Missing DRIVE_FOLDER_ID' });
    const drive = getDriveClient();

    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    const allFiles = listRes.data.files || [];

    // Check which are already imported
    const contractsDoc = await db.collection('cms').doc('contracts').get();
    const contracts = contractsDoc.exists ? (contractsDoc.data().data || []) : [];
    const knownIds = new Set();
    contracts.forEach(c => {
      if (c.driveFileId) knownIds.add(c.driveFileId);
      (c.versions || []).forEach(v => { if (v.driveFileId) knownIds.add(v.driveFileId); });
    });

    const files = allFiles
      .filter(f => SUPPORTED_MIME.includes(f.mimeType))
      .map(f => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        imported: knownIds.has(f.id)
      }))
      .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));

    res.json({ ok: true, files });
  } catch(e) {
    console.error('Drive list-all error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
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

// GET /api/drive/file/:fileId — proxy Drive file to browser (preview or download)
app.get('/api/drive/file/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const download = req.query.download === 'true';
    const drive = getDriveClient();

    // Get file metadata to know mimeType and name
    const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType', supportsAllDrives: true });
    let { name, mimeType } = meta.data;

    let buffer, servedMime;

    if (mimeType === 'application/vnd.google-apps.document') {
      // Google Doc → export as PDF
      const r = await drive.files.export({ fileId, mimeType: 'application/pdf', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      buffer = Buffer.from(r.data);
      servedMime = 'application/pdf';
      name = name.replace(/\.[^.]*$/, '') + '.pdf';
    } else if (mimeType.includes('wordprocessingml') || mimeType.includes('msword')) {
      if (download) {
        // Download original DOCX
        const r = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
        buffer = Buffer.from(r.data);
        servedMime = mimeType;
      } else {
        // Preview: convert DOCX → HTML
        const r = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
        const result = await mammoth.convertToHtml({ buffer: Buffer.from(r.data) });
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body{font-family:Georgia,serif;max-width:860px;margin:40px auto;padding:0 24px;line-height:1.7;color:#222;}
          table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ccc;padding:6px 10px;}
        </style></head><body>${result.value}</body></html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }
    } else {
      // PDF or image — serve directly
      const r = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      buffer = Buffer.from(r.data);
      servedMime = mimeType;
    }

    const disposition = download
      ? `attachment; filename="${encodeURIComponent(name)}"`
      : `inline; filename="${encodeURIComponent(name)}"`;

    res.setHeader('Content-Type', servedMime);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch(e) {
    console.error('Drive file proxy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/drive/migrate-fields — fix field names AND re-run brand+entity classification on all contracts
app.get('/api/drive/migrate-fields', async (req, res) => {
  try {
    const doc = await db.collection('cms').doc('contracts').get();
    if (!doc.exists) return res.json({ ok: true, migrated: 0, message: 'No contracts found' });
    const contracts = doc.data().data || [];
    let fieldFixed = 0, brandResolved = 0, brandUnresolved = 0;

    const updated = contracts.map(c => {
      // ── Step 1: fix old field names ──────────────────────
      const needsFieldFix = c.counterparty !== undefined || c.startDate !== undefined || c.endDate !== undefined;
      if (needsFieldFix) fieldFixed++;

      const fixed = {
        ...c,
        party: c.party || c.counterparty || '',
        isIntercompany: c.isIntercompany !== undefined ? c.isIntercompany : (c.type === 'intercompany'),
        type: (c.type === 'intercompany' || c.type === 'external') ? (c.contractType || '') : (c.type || ''),
        start: c.start || c.startDate || '',
        end: c.end || c.endDate || '',
        fees: c.fees || (c.value ? String(c.value) : ''),
        autoRenewal: c.autoRenewal !== undefined ? c.autoRenewal : (c.autoRenew || false),
        noticePeriodUnit: c.noticePeriodUnit || 'days',
        // remove deprecated fields
        counterparty: undefined, startDate: undefined, endDate: undefined,
        value: undefined, autoRenew: undefined, contractType: undefined,
      };

      // ── Step 2: re-run brand+entity resolution ───────────
      // Try ourEntity (from 'entity' field) first, then counterparty ('party')
      const resolved = resolveEntityInfo(fixed.entity, null)
        || resolveEntityInfo(fixed.party, null);

      if (resolved) {
        fixed.brand = resolved.brand;
        fixed.entity = resolved.entity;
        fixed.brandResolved = true;
        brandResolved++;
      } else {
        fixed.brand = fixed.brand || null;
        fixed.brandResolved = false;
        brandUnresolved++;
      }

      return Object.fromEntries(Object.entries(fixed).filter(([,v]) => v !== undefined));
    });

    await db.collection('cms').doc('contracts').set({ data: updated });
    res.json({ ok: true, total: contracts.length, fieldFixed, brandResolved, brandUnresolved });
  } catch(e) {
    console.error('Migration error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/migrate-ids — reassign all contract IDs to date-based format (YYYYMMDDNN)
app.get('/api/migrate-ids', async (req, res) => {
  try {
    const doc = await db.collection('cms').doc('contracts').get();
    if (!doc.exists) return res.json({ ok: true, migrated: 0 });
    const contracts = doc.data().data || [];

    // Sort by start date, then counterparty alphabetically for same-day ordering
    const sorted = [...contracts].sort((a, b) => {
      const da = (a.start || a.createdAt || '').slice(0, 10);
      const db2 = (b.start || b.createdAt || '').slice(0, 10);
      if (da !== db2) return da < db2 ? -1 : 1;
      return (a.party || '').toLowerCase() < (b.party || '').toLowerCase() ? -1 : 1;
    });

    // Assign new IDs — track counter per date prefix
    const dayCount = {};
    const updated = sorted.map(c => {
      let d;
      const dateStr = c.start || (c.createdAt ? c.createdAt.slice(0, 10) : '');
      if (dateStr) {
        d = dateStr.replace(/-/g, '').slice(0, 8);
      } else {
        const n = new Date();
        d = String(n.getFullYear()) + String(n.getMonth()+1).padStart(2,'0') + String(n.getDate()).padStart(2,'0');
      }
      dayCount[d] = (dayCount[d] || 0) + 1;
      const newId = d + String(dayCount[d]).padStart(2, '0');
      return { ...c, id: newId };
    });

    await db.collection('cms').doc('contracts').set({ data: updated });
    res.json({ ok: true, total: contracts.length, migrated: updated.length, sample: updated.slice(0,5).map(c=>c.id) });
  } catch(e) {
    console.error('migrate-ids error:', e);
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
