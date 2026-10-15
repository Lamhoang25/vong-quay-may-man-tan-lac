const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MONGODB_URI = process.env.MONGODB_URI;
const DEFAULT_SLICES = [
  { name: 'Giảm 10%', color: '#e74c3c', weight: 30, noWin: false },
  { name: 'Giảm 20%', color: '#f39c12', weight: 20, noWin: false },
  { name: 'Quà tặng nhỏ', color: '#27ae60', weight: 20, noWin: false },
  { name: 'Chúc may mắn lần sau', color: '#3498db', weight: 25, noWin: true },
  { name: 'Giải đặc biệt', color: '#9b59b6', weight: 5, noWin: false }];
const newRound = (id, label) => ({ id, label: label || 'Tuần ' + id, open: true, startedAt: new Date().toISOString() });
const isNoWin = s => !!s.noWin || /may mắn lần sau|không trúng/i.test(s.name || '');
class DupError extends Error {}

// ---- JSON file store ----
function jsonStore() {
  let db;
  if (fs.existsSync(DATA)) db = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  else db = { slices: DEFAULT_SLICES, rounds: [newRound(1)], spins: [] };
  const save = () => { const t = DATA + '.tmp'; fs.writeFileSync(t, JSON.stringify(db, null, 1)); fs.renameSync(t, DATA); };
  save();
  return {
    kind: 'json',
    getSlices: async () => db.slices,
    setSlices: async s => { db.slices = s; save(); },
    getRounds: async () => db.rounds,
    current: async () => db.rounds[db.rounds.length - 1],
    updateRound: async (id, patch) => { Object.assign(db.rounds.find(r => r.id === id), patch); save(); },
    addRound: async r => { db.rounds.push(r); save(); },
    findSpin: async (roundId, phone) => db.spins.find(s => s.roundId === roundId && s.phone === phone) || null,
    insertSpin: async s => { if (db.spins.some(x => x.roundId === s.roundId && x.phone === s.phone)) throw new DupError(); db.spins.push(s); save(); },
    listSpins: async () => db.spins,
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
    addRound: async r => { await rounds.insertOne({ ...r }); },
    findSpin: async (roundId, phone) => spins.findOne({ roundId, phone }, P),
    insertSpin: async s => { try { await spins.insertOne({ ...s }); } catch (e) { if (e.code === 11000) throw new DupError(); throw e; } },
    listSpins: async () => spins.find({}, P).sort({ time: 1 }).toArray(),
  };
}

const normPhone = p => { p = String(p || '').replace(/[\s.\-()]/g, ''); if (p.startsWith('+84')) p = '0' + p.slice(3); else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2); return p; };
const validPhone = p => /^0(3|5|7|8|9)\d{8}$/.test(p);
const clean = (s, n) => String(s || '').trim().replace(/[<>]/g, '').slice(0, n);
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); });

async function main() {
  const st = MONGODB_URI ? await mongoStore() : jsonStore();
  const app = express(); app.use(express.json());
  const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
  app.get('/', (req, res) => res.sendFile(path.join(PUB, 'index.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(PUB, 'admin.html')));
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
    res.json({ storage: st.kind, slices, rounds: await st.getRounds(), round: r, stats: { roundPlayers: rs.length, allPlayers: all.length, uniquePhonesAll: new Set(all.map(s => s.phone)).size, perPrizeRound: count(rs), perPrizeAll: count(all) }, spins: [...all].reverse() });
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
    const r = await st.current(); await st.updateRound(r.id, { open: false, closedAt: r.closedAt || new Date().toISOString() });
    await st.addRound(newRound(r.id + 1, clean(req.body.label, 40))); res.json({ ok: true });
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
