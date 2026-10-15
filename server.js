const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let db;
function load() {
  if (fs.existsSync(DATA)) db = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  else db = { slices: [
    { name: 'Giảm 10%', color: '#e74c3c', weight: 30 },
    { name: 'Giảm 20%', color: '#f39c12', weight: 20 },
    { name: 'Quà tặng nhỏ', color: '#27ae60', weight: 20 },
    { name: 'Chúc may mắn lần sau', color: '#3498db', weight: 25 },
    { name: 'Giải đặc biệt', color: '#9b59b6', weight: 5 } ],
    rounds: [{ id: 1, label: 'Tuần 1', open: true, startedAt: new Date().toISOString() }], spins: [] };
  save();
}
function save() { const t = DATA + '.tmp'; fs.writeFileSync(t, JSON.stringify(db, null, 1)); fs.renameSync(t, DATA); }
load();
const cur = () => db.rounds[db.rounds.length - 1];
const normPhone = p => { p = String(p || '').replace(/[\s.\-()]/g, ''); if (p.startsWith('+84')) p = '0' + p.slice(3); else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2); return p; };
const validPhone = p => /^0(3|5|7|8|9)\d{8}$/.test(p);
const clean = (s, n) => String(s || '').trim().replace(/[<>]/g, '').slice(0, n);

const app = express(); app.use(express.json()); const fs0=require('fs'); const PUB=fs0.existsSync(path.join(__dirname,'public','index.html'))?path.join(__dirname,'public'):__dirname; app.get('/', (req,res)=>res.sendFile(path.join(PUB,'index.html')));
app.get('/api/config', (req, res) => { const r = cur(); res.json({ slices: db.slices.map(s => ({ name: s.name, color: s.color })), round: { id: r.id, label: r.label, open: r.open } }); });
app.post('/api/spin', (req, res) => {
  const name = clean(req.body.name, 60), village = clean(req.body.village, 80), phone = normPhone(req.body.phone);
  if (!name || !village) return res.status(400).json({ error: 'Vui lòng nhập đầy đủ Tên và Làng.' });
  if (!validPhone(phone)) return res.status(400).json({ error: 'Số điện thoại không hợp lệ (VD: 0912345678).' });
  const r = cur(); if (!r.open) return res.status(403).json({ error: 'Vòng quay tuần này đã đóng. Hẹn bạn tuần sau!' });
  const prev = db.spins.find(s => s.roundId === r.id && s.phone === phone);
  if (prev) return res.status(409).json({ error: 'Số điện thoại này đã quay trong ' + r.label + '.', result: prev });
  const total = db.slices.reduce((a, s) => a + Math.max(0, +s.weight || 0), 0);
  let x = crypto.randomInt(0, 1e9) / 1e9 * total, idx = 0;
  for (let i = 0; i < db.slices.length; i++) { x -= Math.max(0, +db.slices[i].weight || 0); if (x < 0) { idx = i; break; } }
  const spin = { roundId: r.id, roundLabel: r.label, name, phone, village, prize: db.slices[idx].name, prizeIndex: idx, time: new Date().toISOString() };
  db.spins.push(spin); save(); res.json({ result: spin });
});
// admin
const auth = (req, res, next) => (req.get('x-admin-password') === ADMIN_PASSWORD || req.query.pw === ADMIN_PASSWORD) ? next() : res.status(401).json({ error: 'Sai mật khẩu' });
app.get('/api/admin/state', auth, (req, res) => {
  const r = cur(), rs = db.spins.filter(s => s.roundId === r.id);
  const count = arr => { const m = {}; arr.forEach(s => m[s.prize] = (m[s.prize] || 0) + 1); return m; };
  res.json({ slices: db.slices, rounds: db.rounds, round: r, stats: { roundPlayers: rs.length, allPlayers: db.spins.length, uniquePhonesAll: new Set(db.spins.map(s => s.phone)).size, perPrizeRound: count(rs), perPrizeAll: count(db.spins) }, spins: [...db.spins].reverse() });
});
app.put('/api/admin/slices', auth, (req, res) => {
  const sl = req.body.slices; if (!Array.isArray(sl) || sl.length < 2 || sl.length > 24) return res.status(400).json({ error: 'Cần 2–24 ô' });
  const out = sl.map(s => ({ name: clean(s.name, 40) || 'Ô', color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#888888', weight: Math.max(0, Number(s.weight) || 0) }));
  if (!out.some(s => s.weight > 0)) return res.status(400).json({ error: 'Ít nhất một ô phải có tỉ lệ > 0' });
  db.slices = out; save(); res.json({ ok: true });
});
app.post('/api/admin/round/open', auth, (req, res) => { cur().open = true; save(); res.json({ ok: true }); });
app.post('/api/admin/round/close', auth, (req, res) => { cur().open = false; cur().closedAt = new Date().toISOString(); save(); res.json({ ok: true }); });
app.post('/api/admin/round/new', auth, (req, res) => {
  const r = cur(); r.open = false; r.closedAt = r.closedAt || new Date().toISOString();
  const id = r.id + 1; db.rounds.push({ id, label: clean(req.body.label, 40) || 'Tuần ' + id, open: true, startedAt: new Date().toISOString() }); save(); res.json({ ok: true });
});
app.get('/api/admin/export.csv', auth, (req, res) => {
  const rid = req.query.round ? +req.query.round : null;
  const rows = db.spins.filter(s => !rid || s.roundId === rid);
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const csv = '\uFEFF' + ['Vòng,Tên,Số điện thoại,Làng,Giải,Thời gian'].concat(rows.map(s => [s.roundLabel, s.name, "'" + s.phone, s.village, s.prize, new Date(s.time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })].map(q).join(','))).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="vong-quay.csv"').send(csv);
});
app.get('/admin', (req, res) => res.sendFile(path.join(PUB, 'admin.html')));
app.listen(PORT, () => console.log('Vòng Quay May Mắn chạy tại http://localhost:' + PORT + ' (admin: /admin)'));
