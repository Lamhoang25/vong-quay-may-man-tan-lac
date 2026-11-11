const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MONGODB_URI = process.env.MONGODB_URI;
// Chỉ lưu danh sách của N tuần (vòng) mới nhất, kể cả tuần hiện tại. Tuần cũ hơn tự động xóa.
const KEEP_ROUNDS = Math.max(2, parseInt(process.env.KEEP_ROUNDS, 10) || 4);
// ---- Gửi email qua HTTPS (Render gói Free chặn cổng SMTP). Chỉ đọc từ biến môi trường do bạn tự đặt trên Render. ----
// Cách 1 (khuyên dùng): Google Apps Script web app -> EMAIL_WEBHOOK_URL + EMAIL_WEBHOOK_SECRET
// Cách 2: Brevo (miễn phí) -> BREVO_API_KEY + EMAIL_FROM (email người gửi đã xác minh trên Brevo)
const EMAIL_WEBHOOK_URL = process.env.EMAIL_WEBHOOK_URL || '', EMAIL_WEBHOOK_SECRET = process.env.EMAIL_WEBHOOK_SECRET || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '', EMAIL_FROM = process.env.EMAIL_FROM || '';
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const EMAIL_PROVIDER = EMAIL_WEBHOOK_URL && EMAIL_WEBHOOK_SECRET ? 'apps-script' : (BREVO_API_KEY && EMAIL_FROM ? 'brevo' : null);
const DEFAULT_SETTINGS = { auto: true, closeDay: 1, closeTime: '00:00', weeks: 1, emailTo: 'vtnntanlac@gmail.com' };
const DEFAULT_SLICES = [
  { name: 'Giảm 10%', color: '#e74c3c', weight: 30, noWin: false },
  { name: 'Giảm 20%', color: '#f39c12', weight: 20, noWin: false },
  { name: 'Quà tặng nhỏ', color: '#27ae60', weight: 20, noWin: false },
  { name: 'Chúc may mắn lần sau', color: '#3498db', weight: 25, noWin: true },
  { name: 'Giải đặc biệt', color: '#9b59b6', weight: 5, noWin: false }];
const newRound = (id, label, extra) => ({ id, label: label || 'Tuần ' + id, open: true, startedAt: new Date().toISOString(), ...(extra || {}) });

// ---- Giờ Việt Nam (UTC+7, không đổi giờ mùa hè) ----
const VN = 7 * 3600e3, DAY = 86400e3, WEEK = 7 * DAY;
const vn = ms => { const d = new Date(ms + VN); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() }; };
const DOW = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const hm = t => { const [h, m] = String(t).split(':').map(Number); return h * 3600e3 + m * 60e3; };
// Thời điểm (ngày closeDay, giờ closeTime, giờ VN) đầu tiên SAU mốc afterMs
function nextBoundary(afterMs, sch) {
  const local = afterMs + VN, day0 = Math.floor(local / DAY) * DAY;
  for (let k = 0; k <= 8; k++) { const c = day0 + k * DAY + hm(sch.closeTime); if (new Date(c).getUTCDay() === sch.closeDay && c > local) return c - VN; }
}
// Thời điểm kết thúc của vòng bắt đầu lúc startMs; không bao giờ trả về mốc đã qua
function computeEnd(startMs, sch, nowMs) {
  let end = nextBoundary(startMs, sch) + (sch.weeks - 1) * WEEK;
  if (end <= nowMs) end = nextBoundary(nowMs, sch);
  return end;
}
// Tên vòng theo ngày, VD "Ngày 9 đến ngày 15 tháng 11", "Ngày 30 tháng 11 đến ngày 6 tháng 12"
function roundName(startMs, endMs) {
  const a = vn(startMs), b = vn(endMs - 1000);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return 'Ngày ' + a.d + ' tháng ' + a.m;
  if (a.y !== b.y) return 'Ngày ' + a.d + ' tháng ' + a.m + ' năm ' + a.y + ' đến ngày ' + b.d + ' tháng ' + b.m + ' năm ' + b.y;
  if (a.m !== b.m) return 'Ngày ' + a.d + ' tháng ' + a.m + ' đến ngày ' + b.d + ' tháng ' + b.m;
  return 'Ngày ' + a.d + ' đến ngày ' + b.d + ' tháng ' + b.m;
}
const fmtVN = ms => new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const isNoWin = s => !!s.noWin || /may mắn lần sau|không trúng/i.test(s.name || '');
class DupError extends Error {}

// ---- JSON file store ----
function jsonStore() {
  let db;
  if (fs.existsSync(DATA)) db = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  else db = { slices: DEFAULT_SLICES, rounds: [newRound(1)], spins: [] };
  if (!db.settings) db.settings = { ...DEFAULT_SETTINGS };
  const save = () => { const t = DATA + '.tmp'; fs.writeFileSync(t, JSON.stringify(db, null, 1)); fs.renameSync(t, DATA); };
  save();
  return {
    kind: 'json',
    getSlices: async () => db.slices,
    setSlices: async s => { db.slices = s; save(); },
    getRounds: async () => db.rounds,
    current: async () => db.rounds[db.rounds.length - 1],
    updateRound: async (id, patch) => { Object.assign(db.rounds.find(r => r.id === id), patch); save(); },
    addRound: async r => { if (db.rounds.some(x => x.id === r.id)) throw new DupError(); db.rounds.push(r); save(); },
    getRound: async id => db.rounds.find(r => r.id === id) || null,
    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...db.settings }),
    setSettings: async x => { db.settings = { ...DEFAULT_SETTINGS, ...db.settings, ...x }; save(); },
    // Giữ quyền gửi email cho 1 vòng (chỉ khi trạng thái nằm trong danh sách cho phép) -> chống gửi trùng
    claimEmail: async (id, allowed) => { const r = db.rounds.find(x => x.id === id); if (!r || (allowed && !allowed.includes(r.emailStatus))) return null; r.emailStatus = 'sending'; save(); return { ...r }; },
    spinsOf: async id => db.spins.filter(s => s.roundId === id),
    findSpin: async (roundId, phone) => db.spins.find(s => s.roundId === roundId && s.phone === phone) || null,
    insertSpin: async s => { if (db.spins.some(x => x.roundId === s.roundId && x.phone === s.phone)) throw new DupError(); db.spins.push(s); save(); },
    listSpins: async () => db.spins,
    deleteSpins: async ids => { const n = db.spins.length; db.spins = db.spins.filter(s => !ids.includes(s.roundId)); save(); return n - db.spins.length; },
    deleteRounds: async ids => { db.rounds = db.rounds.filter(r => !ids.includes(r.id)); save(); },
  };
}

// ---- MongoDB store ----
async function mongoStore() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGODB_URI); await client.connect();
  const d = client.db('vongquay'), cfg = d.collection('config'), rounds = d.collection('rounds'), spins = d.collection('spins');
  await spins.createIndex({ roundId: 1, phone: 1 }, { unique: true });
  await rounds.createIndex({ id: 1 }, { unique: true });
  await cfg.updateOne({ _id: 'wheel' }, { $setOnInsert: { slices: DEFAULT_SLICES } }, { upsert: true });
  if (!(await rounds.countDocuments())) await rounds.insertOne(newRound(1)).catch(() => {});
  const P = { projection: { _id: 0 } };
  return {
    kind: 'mongodb',
    getSlices: async () => (await cfg.findOne({ _id: 'wheel' })).slices,
    setSlices: async s => { await cfg.updateOne({ _id: 'wheel' }, { $set: { slices: s } }, { upsert: true }); },
    getRounds: async () => rounds.find({}, P).sort({ id: 1 }).toArray(),
    current: async () => rounds.findOne({}, { ...P, sort: { id: -1 } }),
    updateRound: async (id, patch) => { await rounds.updateOne({ id }, { $set: patch }); },
    addRound: async r => { try { await rounds.insertOne({ ...r }); } catch (e) { if (e.code === 11000) throw new DupError(); throw e; } },
    getRound: async id => rounds.findOne({ id }, P),
    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...((await cfg.findOne({ _id: 'settings' }, P)) || {}) }),
    setSettings: async x => { await cfg.updateOne({ _id: 'settings' }, { $set: x }, { upsert: true }); },
    claimEmail: async (id, allowed) => { const q = allowed ? { id, emailStatus: { $in: allowed } } : { id }; const r = await rounds.findOneAndUpdate(q, { $set: { emailStatus: 'sending' } }, { ...P, returnDocument: 'after' }); return r && r.value !== undefined && r.ok !== undefined ? r.value : r; },
    spinsOf: async id => spins.find({ roundId: id }, P).sort({ time: 1 }).toArray(),
    findSpin: async (roundId, phone) => spins.findOne({ roundId, phone }, P),
    insertSpin: async s => { try { await spins.insertOne({ ...s }); } catch (e) { if (e.code === 11000) throw new DupError(); throw e; } },
    listSpins: async () => spins.find({}, P).sort({ time: 1 }).toArray(),
    deleteSpins: async ids => (await spins.deleteMany({ roundId: { $in: ids } })).deletedCount,
    deleteRounds: async ids => { await rounds.deleteMany({ id: { $in: ids } }); },
  };
}

const normPhone = p => { p = String(p || '').replace(/[\s.\-()]/g, ''); if (p.startsWith('+84')) p = '0' + p.slice(3); else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2); return p; };
const validPhone = p => /^0(3|5|7|8|9)\d{8}$/.test(p);
const clean = (s, n) => String(s || '').trim().replace(/[<>]/g, '').slice(0, n);
// Xóa các tuần cũ (cũ nhất trước), chỉ giữ KEEP_ROUNDS tuần mới nhất theo số thứ tự vòng.
async function pruneOldRounds(st) {
  const all = [...(await st.getRounds())].sort((a, b) => a.id - b.id);
  if (all.length <= KEEP_ROUNDS) return 0;
  const old = all.slice(0, all.length - KEEP_ROUNDS), spins = await st.listSpins();
  let total = 0;
  for (const r of old) {
    const n = spins.filter(s => s.roundId === r.id).length;
    console.log('[Dọn dữ liệu] Xóa ' + r.label + ' (vòng ' + r.id + '): ' + n + ' lượt quay');
    total += await st.deleteSpins([r.id]);
    await st.deleteRounds([r.id]);
  }
  console.log('[Dọn dữ liệu] Đã xóa ' + old.length + ' tuần cũ, tổng ' + total + ' lượt quay. Giữ lại ' + KEEP_ROUNDS + ' tuần mới nhất.');
  return total;
}
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); });

// ---- Email danh sách trúng thưởng ----
const escH = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const validEmails = v => { const L = String(v || '').split(/[,;\s]+/).filter(Boolean); return L.length && L.length <= 5 && L.every(e => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e)) ? L.join(', ') : null; };
function buildEmail(round, spins) {
  const win = spins.filter(s => s.win), cnt = {};
  win.forEach(s => cnt[s.prize] = (cnt[s.prize] || 0) + 1);
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const csv = '\uFEFF' + ['STT,Tên,Số điện thoại,Làng,Giải,Thời gian'].concat(win.map((s, i) => [i + 1, s.name, "'" + s.phone, s.village, s.prize, fmtVN(Date.parse(s.time))].map(q).join(','))).join('\r\n');
  const td = 'style="border:1px solid #ccc;padding:6px"';
  const span = round.startedAt ? 'Từ ' + fmtVN(Date.parse(round.startedAt)) + ' đến ' + fmtVN(Date.parse(round.closedAt || round.endsAt || new Date().toISOString())) + ' (giờ Việt Nam)' : '';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px">' +
    '<h2>🎡 Vòng Quay May Mắn Tân Lạc</h2><p>Danh sách trúng thưởng của vòng <b>' + escH(round.label) + '</b> (vòng số ' + round.id + ').<br>' + escH(span) + '</p>' +
    '<p>Tổng lượt quay: <b>' + spins.length + '</b> &nbsp; Số người trúng thưởng: <b>' + win.length + '</b></p>' +
    (Object.keys(cnt).length ? '<p>' + Object.keys(cnt).map(k => escH(k) + ': <b>' + cnt[k] + '</b>').join('<br>') + '</p>' : '') +
    (win.length ? '<table style="border-collapse:collapse"><tr>' + ['STT', 'Tên', 'Số điện thoại', 'Làng', 'Giải', 'Thời gian'].map(h => '<th ' + td + '>' + h + '</th>').join('') + '</tr>' +
      win.map((s, i) => '<tr>' + [i + 1, s.name, s.phone, s.village, s.prize, fmtVN(Date.parse(s.time))].map(v => '<td ' + td + '>' + escH(v) + '</td>').join('') + '</tr>').join('') + '</table>'
      : '<p>Vòng này không có ai trúng thưởng.</p>') +
    '<p style="color:#666">File CSV đính kèm (mở bằng Excel). Email gửi tự động từ trang quản lý vòng quay.</p></div>';
  const fname = 'trung-thuong-vong-' + round.id + '.csv';
  return { subject: '[Vòng Quay Tân Lạc] Danh sách trúng thưởng: ' + round.label, html, attachments: [{ name: fname, mimeType: 'text/csv', base64: Buffer.from(csv, 'utf8').toString('base64') }], winners: win.length };
}
async function deliver(to, mail) {
  const signal = AbortSignal.timeout(30000);
  if (EMAIL_PROVIDER === 'apps-script') {
    const r = await fetch(EMAIL_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: EMAIL_WEBHOOK_SECRET, to, subject: mail.subject, html: mail.html, attachments: mail.attachments }), redirect: 'follow', signal });
    const t = await r.text(); let d; try { d = JSON.parse(t); } catch { throw new Error('Apps Script trả về không phải JSON (HTTP ' + r.status + '). Kiểm tra lại: Deploy dạng Web app, "Who has access: Anyone".'); }
    if (!d.ok) throw new Error('Apps Script báo lỗi: ' + (d.error || 'không rõ'));
    return;
  }
  if (EMAIL_PROVIDER === 'brevo') {
    const r = await fetch(BREVO_API_URL, { method: 'POST', headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' }, signal,
      body: JSON.stringify({ sender: { email: EMAIL_FROM, name: 'Vòng Quay Tân Lạc' }, to: to.split(', ').map(email => ({ email })), subject: mail.subject, htmlContent: mail.html, attachment: mail.attachments.map(a => ({ name: a.name, content: a.base64 })) }) });
    if (!r.ok) throw new Error('Brevo báo lỗi HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return;
  }
  throw new Error('Chưa cài đặt gửi email');
}
// Gửi email cho 1 vòng đã đóng. force=false: chỉ gửi khi đang chờ/lỗi (không gửi trùng). force=true: nút "Gửi lại".
async function sendRoundEmail(st, id, force) {
  const r = await st.claimEmail(id, force ? null : ['pending', 'failed']);
  if (!r) return { status: 'none' };
  if (!EMAIL_PROVIDER) { await st.updateRound(id, { emailStatus: 'skipped', emailError: 'Chưa cài biến môi trường gửi email trên Render' }); console.log('[Email] Bỏ qua ' + r.label + ': chưa cài gửi email'); return { status: 'skipped' }; }
  const to = (await st.getSettings()).emailTo || DEFAULT_SETTINGS.emailTo;
  try {
    const mail = buildEmail(r, await st.spinsOf(id));
    await deliver(to, mail);
    await st.updateRound(id, { emailStatus: 'sent', emailSentAt: new Date().toISOString(), emailTo: to, emailError: null, emailAttempts: (r.emailAttempts || 0) + 1 });
    console.log('[Email] Đã gửi danh sách trúng thưởng ' + r.label + ' (' + mail.winners + ' người) tới ' + to);
    return { status: 'sent', to };
  } catch (e) {
    await st.updateRound(id, { emailStatus: 'failed', emailError: String(e.message || e).slice(0, 300), emailAttempts: (r.emailAttempts || 0) + 1 });
    console.error('[Email] Lỗi gửi ' + r.label + ':', e.message || e);
    return { status: 'failed', error: String(e.message || e) };
  }
}
// Tự gửi lại các email đang chờ / bị lỗi (tối đa 3 lần)
async function retryEmails(st) {
  for (const r of await st.getRounds()) if (r.emailStatus === 'pending' || (r.emailStatus === 'failed' && (r.emailAttempts || 0) < 3)) await sendRoundEmail(st, r.id, false);
}

// Đóng vòng cũ, mở vòng mới (dùng chung cho tự động và nút "Bắt đầu tuần mới"). Chống tạo trùng nhờ khóa id duy nhất.
async function rollover(st, r, closedAt, nr) {
  await st.updateRound(r.id, { open: false, closedAt: r.closedAt && r.closedAt < closedAt ? r.closedAt : closedAt, emailStatus: r.emailStatus || 'pending' });
  try { await st.addRound(nr); } catch (e) { if (e instanceof DupError) return false; throw e; }
  await pruneOldRounds(st);
  sendRoundEmail(st, r.id, false).catch(e => console.error('[Email]', e));
  return true;
}
let checking = null;
// Kiểm tra lười: gọi khi khởi động, mỗi phút khi máy đang thức, và trước mỗi request /api. Gọi bao nhiêu lần cũng an toàn.
function ensureSchedule(st) {
  if (!checking) checking = (async () => {
    const sch = await st.getSettings(); if (!sch.auto) return;
    const now = Date.now(), r = await st.current();
    if (!r.endsAt) { // vòng chưa có lịch (vòng đang chạy lúc mới deploy, hoặc vừa bật lại tự động)
      const end = computeEnd(Date.parse(r.startedAt) || now, sch, now);
      await st.updateRound(r.id, { endsAt: new Date(end).toISOString() });
      console.log('[Lịch] ' + r.label + ' sẽ tự đóng lúc ' + fmtVN(end));
      return;
    }
    const endMs = Date.parse(r.endsAt); if (now < endMs) return;
    // Đã qua giờ đóng. Nếu máy ngủ qua nhiều kỳ, chỉ mở 1 vòng mới cho kỳ hiện tại (không tạo các vòng trống).
    let start = endMs, end = start + sch.weeks * WEEK;
    while (end <= now) { start = end; end += sch.weeks * WEEK; }
    const label = roundName(start, end);
    if (await rollover(st, r, r.endsAt, newRound(r.id + 1, label, { startedAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), autoLabel: true, openedBy: 'auto' })))
      console.log('[Lịch] Tự đóng ' + r.label + ', mở vòng mới: ' + label + ' (đóng lúc ' + fmtVN(end) + ')');
  })().finally(() => { checking = null; });
  return checking;
}

async function main() {
  const st = MONGODB_URI ? await mongoStore() : jsonStore();
  await pruneOldRounds(st);
  await ensureSchedule(st).catch(e => console.error('[Lịch]', e));
  retryEmails(st).catch(e => console.error('[Email]', e));
  setInterval(() => { ensureSchedule(st).then(() => retryEmails(st)).catch(e => console.error('[Lịch]', e)); }, Math.max(200, parseInt(process.env.SCHEDULE_CHECK_MS, 10) || 60e3)).unref?.();
  const app = express(); app.use(express.json());
  app.use('/api', (req, res, next) => { ensureSchedule(st).catch(e => console.error('[Lịch]', e)).then(() => next()); });
  const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
  app.get('/', (req, res) => res.sendFile(path.join(PUB, 'index.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(PUB, 'admin.html')));
  // Dùng để "đánh thức" máy chủ (VD đặt cron-job.org gọi lúc 00:05 thứ Hai) -> tự đóng/mở vòng và gửi email đúng giờ
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', wrap(async (req, res) => { const r = await st.current(), sl = await st.getSlices(); res.json({ slices: sl.map(s => ({ name: s.name, color: s.color, noWin: isNoWin(s) })), round: { id: r.id, label: r.label, open: r.open } }); }));
  app.post('/api/spin', wrap(async (req, res) => {
    const name = clean(req.body.name, 60), village = clean(req.body.village, 80), phone = normPhone(req.body.phone);
    if (!name || !village) return res.status(400).json({ error: 'Vui lòng nhập đầy đủ Tên và Làng.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Số điện thoại không hợp lệ (VD: 0912345678).' });
    const r = await st.current(); if (!r.open) return res.status(403).json({ error: 'Vòng quay tuần này đã đóng. Hẹn bạn tuần sau!' });
    const dup = async () => res.status(409).json({ error: 'Số điện thoại này đã quay trong ' + r.label + '.', result: await st.findSpin(r.id, phone) });
    if (await st.findSpin(r.id, phone)) return dup();
    const slices = await st.getSlices();
    const total = slices.reduce((a, s) => a + Math.max(0, +s.weight || 0), 0);
    let x = crypto.randomInt(0, 1e9) / 1e9 * total, idx = 0;
    for (let i = 0; i < slices.length; i++) { x -= Math.max(0, +slices[i].weight || 0); if (x < 0) { idx = i; break; } }
    const spin = { roundId: r.id, roundLabel: r.label, name, phone, village, prize: slices[idx].name, prizeIndex: idx, win: !isNoWin(slices[idx]), time: new Date().toISOString() };
    try { await st.insertSpin(spin); } catch (e) { if (e instanceof DupError) return dup(); throw e; }
    res.json({ result: spin });
  }));
  const auth = (req, res, next) => (req.get('x-admin-password') === ADMIN_PASSWORD || req.query.pw === ADMIN_PASSWORD) ? next() : res.status(401).json({ error: 'Sai mật khẩu' });
  app.get('/api/admin/state', auth, wrap(async (req, res) => {
    const r = await st.current(), all = await st.listSpins(), rs = all.filter(s => s.roundId === r.id);
    const count = arr => { const m = {}; arr.forEach(s => m[s.prize] = (m[s.prize] || 0) + 1); return m; };
    const slices = (await st.getSlices()).map(s => ({ ...s, noWin: isNoWin(s) }));
    const settings = await st.getSettings(), now = Date.now();
    const nextClose = settings.auto ? (r.endsAt ? Date.parse(r.endsAt) : computeEnd(Date.parse(r.startedAt) || now, settings, now)) : null;
    res.json({ storage: st.kind, keepRounds: KEEP_ROUNDS, settings, nextClose: nextClose && new Date(nextClose).toISOString(), nextCloseText: nextClose && fmtVN(nextClose),
      email: { provider: EMAIL_PROVIDER, configured: !!EMAIL_PROVIDER }, slices, rounds: await st.getRounds(), round: r, stats: { roundPlayers: rs.length, allPlayers: all.length, uniquePhonesAll: new Set(all.map(s => s.phone)).size, perPrizeRound: count(rs), perPrizeAll: count(all) }, spins: [...all].reverse() });
  }));
  app.put('/api/admin/slices', auth, wrap(async (req, res) => {
    const sl = req.body.slices; if (!Array.isArray(sl) || sl.length < 2 || sl.length > 24) return res.status(400).json({ error: 'Cần 2–24 ô' });
    const out = sl.map(s => ({ name: clean(s.name, 40) || 'Ô', color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#888888', weight: Math.max(0, Number(s.weight) || 0), noWin: !!s.noWin }));
    if (!out.some(s => s.weight > 0)) return res.status(400).json({ error: 'Ít nhất một ô phải có tỉ lệ > 0' });
    await st.setSlices(out); res.json({ ok: true });
  }));
  app.post('/api/admin/round/open', auth, wrap(async (req, res) => { await st.updateRound((await st.current()).id, { open: true }); res.json({ ok: true }); }));
  app.post('/api/admin/round/close', auth, wrap(async (req, res) => { await st.updateRound((await st.current()).id, { open: false, closedAt: new Date().toISOString() }); res.json({ ok: true }); }));
  app.post('/api/admin/round/new', auth, wrap(async (req, res) => {
    const r = await st.current(), sch = await st.getSettings(), now = Date.now(), label = clean(req.body.label, 40);
    let extra = { openedBy: 'manual' }, name = label;
    if (sch.auto) { const end = computeEnd(now, sch, now); extra = { ...extra, endsAt: new Date(end).toISOString(), autoLabel: !label }; if (!label) name = roundName(now, end); }
    const ok = await rollover(st, r, new Date(now).toISOString(), newRound(r.id + 1, name, extra));
    if (!ok) return res.status(409).json({ error: 'Vòng mới vừa được tạo, vui lòng tải lại trang.' });
    res.json({ ok: true });
  }));
  // Cài đặt lịch tự động + email nhận danh sách
  app.put('/api/admin/settings', auth, wrap(async (req, res) => {
    const b = req.body || {}, closeDay = +b.closeDay, weeks = +b.weeks, closeTime = String(b.closeTime || '');
    if (!(closeDay >= 0 && closeDay <= 6 && Number.isInteger(closeDay))) return res.status(400).json({ error: 'Ngày không hợp lệ' });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime)) return res.status(400).json({ error: 'Giờ không hợp lệ (VD 00:00)' });
    if (!(weeks >= 1 && weeks <= 4 && Number.isInteger(weeks))) return res.status(400).json({ error: 'Độ dài vòng phải từ 1 đến 4 tuần' });
    const emailTo = validEmails(b.emailTo); if (!emailTo) return res.status(400).json({ error: 'Email nhận không hợp lệ' });
    const sch = { auto: !!b.auto, closeDay, closeTime, weeks, emailTo };
    await st.setSettings(sch);
    // Tính lại giờ đóng của vòng hiện tại theo lịch mới (không bao giờ đóng ngay lập tức)
    const r = await st.current(), now = Date.now();
    if (sch.auto) {
      const end = computeEnd(Date.parse(r.startedAt) || now, sch, now), patch = { endsAt: new Date(end).toISOString() };
      if (r.autoLabel) patch.label = roundName(Date.parse(r.startedAt), end);
      await st.updateRound(r.id, patch);
    } else await st.updateRound(r.id, { endsAt: null });
    res.json({ ok: true });
  }));
  // Gửi lại email danh sách trúng thưởng (mặc định: vòng vừa đóng gần nhất)
  app.post('/api/admin/email/resend', auth, wrap(async (req, res) => {
    const cur = await st.current(), all = await st.getRounds();
    const id = req.body && req.body.roundId ? +req.body.roundId : Math.max(0, ...all.filter(x => x.id < cur.id).map(x => x.id));
    const r = id && await st.getRound(id); if (!r) return res.status(404).json({ error: 'Chưa có vòng nào đã đóng để gửi.' });
    if (!EMAIL_PROVIDER) return res.status(400).json({ error: 'Chưa cài đặt gửi email (thiếu biến môi trường trên Render). Xem hướng dẫn.' });
    const out = await sendRoundEmail(st, id, true);
    if (out.status !== 'sent') return res.status(502).json({ error: 'Gửi email thất bại: ' + (out.error || out.status) });
    res.json({ ok: true, to: out.to, label: r.label });
  }));
  app.get('/api/admin/export.csv', auth, wrap(async (req, res) => {
    const rid = req.query.round ? +req.query.round : null;
    const rows = (await st.listSpins()).filter(s => !rid || s.roundId === rid);
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    const csv = '\uFEFF' + ['Vòng,Tên,Số điện thoại,Làng,Giải,Thời gian'].concat(rows.map(s => [s.roundLabel, s.name, "'" + s.phone, s.village, s.prize, new Date(s.time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })].map(q).join(','))).join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="vong-quay.csv"').send(csv);
  }));
  app.listen(PORT, () => console.log('Vòng Quay May Mắn - Tân Lạc chạy tại http://localhost:' + PORT + ' (admin: /admin), lưu trữ: ' + st.kind));
}
main().catch(e => { console.error('Không khởi động được:', e); process.exit(1); });
