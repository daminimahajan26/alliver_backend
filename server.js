require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { z } = require('zod');
const db = require('./db');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.startsWith('change-me')) {
  console.warn('WARNING: set a strong JWT_SECRET in .env before going live.');
}
const SECRET = JWT_SECRET || 'dev-only-secret';

// ---------- seed admin ----------
(function seedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  const exists = db.prepare('SELECT id FROM admins WHERE email = ?').get(ADMIN_EMAIL);
  if (!exists) {
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)')
      .run(ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 12));
    console.log(`Admin created: ${ADMIN_EMAIL}`);
  }
})();

// ---------- mail ----------
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function notifyLead(l) {
  if (!mailer || !process.env.NOTIFY_TO) return;
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.NOTIFY_TO,
      replyTo: l.email,
      subject: `New lead: ${l.name}${l.service ? ' – ' + l.service : ''}`,
      html: `<h3>New enquiry on allivermarketing.in</h3>
        <p><b>Name:</b> ${esc(l.name)}<br><b>Email:</b> ${esc(l.email)}<br>
        <b>Phone:</b> ${esc(l.phone)}<br><b>Company:</b> ${esc(l.company)}<br>
        <b>Service:</b> ${esc(l.service)}<br><b>Budget:</b> ${esc(l.budget)}</p>
        <p>${esc(l.message).replace(/\n/g, '<br>')}</p>`,
    });
    if (l.email) {
      await mailer.sendMail({
        from: process.env.MAIL_FROM,
        to: l.email,
        subject: 'Thanks for reaching out to ALLIVER',
        html: `<p>Hi ${esc(l.name)},</p><p>Thanks for contacting ALLIVER. We've received your message and will get back to you within one business day.</p><p>— Team ALLIVER</p>`,
      });
    }
  } catch (e) { console.error('Mail error:', e.message); }
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));
app.use(express.json({ limit: '1mb' }));

const formLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, try later.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts.' } });
app.get('/', (_, res) => res.json({ status: 'OK', message: 'ALLIVER API is running' }));
app.get('/api/health', (_, res) => res.json({ ok: true }));
  const r = schema.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: 'Validation failed', details: r.error.flatten().fieldErrors });
  req.body = r.data; next();
};
const auth = (req, res, next) => {
  const h = req.headers.authorization || '';
  try { req.admin = jwt.verify(h.replace(/^Bearer /, ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
};
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (_, res) => res.json({ ok: true }));

// ---------- public: leads & newsletter ----------
const leadSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(150),
  phone: z.string().trim().max(30).optional().default(''),
  company: z.string().trim().max(120).optional().default(''),
  service: z.string().trim().max(120).optional().default(''),
  budget: z.string().trim().max(60).optional().default(''),
  message: z.string().trim().max(3000).optional().default(''),
  source: z.string().trim().max(120).optional().default(''),
  website: z.string().optional(), // honeypot – hidden field bots fill in
});

app.post('/api/leads', formLimiter, validate(leadSchema), wrap(async (req, res) => {
  const l = req.body;
  if (l.website) return res.status(201).json({ ok: true }); // silently drop bots
  const info = db.prepare(`INSERT INTO leads (name,email,phone,company,service,budget,message,source,ip)
    VALUES (@name,@email,@phone,@company,@service,@budget,@message,@source,@ip)`)
    .run({ ...l, ip: req.ip });
  notifyLead(l);
  res.status(201).json({ ok: true, id: info.lastInsertRowid, message: "Thanks! We'll be in touch shortly." });
}));

app.post('/api/newsletter', formLimiter, validate(z.object({ email: z.string().trim().email().max(150) })), (req, res) => {
  db.prepare('INSERT OR IGNORE INTO subscribers (email) VALUES (?)').run(req.body.email.toLowerCase());
  res.status(201).json({ ok: true, message: 'Subscribed!' });
});

// ---------- content resources (public read + admin CRUD) ----------
const slugify = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const str = (n = 500) => z.string().trim().max(n).optional();
const bool = z.union([z.boolean(), z.number()]).optional().transform(v => (v === undefined ? undefined : v ? 1 : 0));

const resources = {
  services: {
    order: 'sort_order ASC, id ASC', slugFrom: 'title',
    schema: z.object({ title: z.string().trim().min(1).max(150), slug: str(150), summary: str(500), description: str(10000), icon: str(100), sort_order: z.number().int().optional(), published: bool }),
  },
  projects: {
    order: 'sort_order ASC, id DESC', slugFrom: 'title',
    schema: z.object({ title: z.string().trim().min(1).max(150), slug: str(150), client: str(150), category: str(100), summary: str(1000), results: str(2000), image_url: str(500), link: str(500), sort_order: z.number().int().optional(), published: bool }),
  },
  posts: {
    order: 'COALESCE(published_at, created_at) DESC', slugFrom: 'title', publicWhere: "published = 1", publicList: 'id,title,slug,excerpt,cover_url,author,published_at',
    schema: z.object({ title: z.string().trim().min(1).max(200), slug: str(200), excerpt: str(500), content: str(100000), cover_url: str(500), author: str(100), published: bool, published_at: str(40) }),
  },
  testimonials: {
    order: 'sort_order ASC, id DESC',
    schema: z.object({ name: z.string().trim().min(1).max(100), role: str(100), company: str(120), quote: z.string().trim().min(1).max(1500), avatar_url: str(500), sort_order: z.number().int().optional(), published: bool }),
  },
};

for (const [table, cfg] of Object.entries(resources)) {
  const pub = cfg.publicWhere || 'published = 1';

  // public
  app.get(`/api/${table}`, (req, res) => {
    const cols = cfg.publicList || '*';
    res.json(db.prepare(`SELECT ${cols} FROM ${table} WHERE ${pub} ORDER BY ${cfg.order}`).all());
  });
  if (cfg.slugFrom) {
    app.get(`/api/${table}/:slug`, (req, res) => {
      const row = db.prepare(`SELECT * FROM ${table} WHERE slug = ? AND ${pub}`).get(req.params.slug);
      row ? res.json(row) : res.status(404).json({ error: 'Not found' });
    });
  }

  // admin
  app.get(`/api/admin/${table}`, auth, (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ORDER BY ${cfg.order}`).all()));

  app.post(`/api/admin/${table}`, auth, validate(cfg.schema), (req, res) => {
    const d = { ...req.body };
    if (cfg.slugFrom) d.slug = slugify(d.slug || d[cfg.slugFrom]);
    if (table === 'posts' && d.published && !d.published_at) d.published_at = new Date().toISOString();
    Object.keys(d).forEach(k => d[k] === undefined && delete d[k]);
    const keys = Object.keys(d);
    try {
      const info = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k => '@' + k).join(',')})`).run(d);
      res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Slug already exists' });
      throw e;
    }
  });

  app.put(`/api/admin/${table}/:id`, auth, validate(cfg.schema.partial()), (req, res) => {
    const d = { ...req.body };
    if (d.slug) d.slug = slugify(d.slug);
    if (table === 'posts' && d.published && !d.published_at) d.published_at = new Date().toISOString();
    Object.keys(d).forEach(k => d[k] === undefined && delete d[k]);
    const keys = Object.keys(d);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      const info = db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k}=@${k}`).join(',')} WHERE id=@id`).run({ ...d, id: req.params.id });
      if (!info.changes) return res.status(404).json({ error: 'Not found' });
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Slug already exists' });
      throw e;
    }
  });

  app.delete(`/api/admin/${table}/:id`, auth, (req, res) => {
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    info.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  });
}

// ---------- admin: auth ----------
app.post('/api/auth/login', loginLimiter, validate(z.object({ email: z.string().email(), password: z.string().min(1) })), (req, res) => {
  const a = db.prepare('SELECT * FROM admins WHERE email = ?').get(req.body.email);
  if (!a || !bcrypt.compareSync(req.body.password, a.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: jwt.sign({ id: a.id, email: a.email }, SECRET, { expiresIn: '8h' }) });
});

app.post('/api/admin/change-password', auth, validate(z.object({ current: z.string(), next: z.string().min(10) })), (req, res) => {
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
  if (!bcrypt.compareSync(req.body.current, a.password_hash)) return res.status(400).json({ error: 'Current password incorrect' });
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.next, 12), a.id);
  res.json({ ok: true });
});

// ---------- admin: leads, subscribers, stats ----------
const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'];

app.get('/api/admin/leads', auth, (req, res) => {
  const { status, q } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 25);
  const where = [], params = {};
  if (status) { where.push('status = @status'); params.status = status; }
  if (q) { where.push('(name LIKE @q OR email LIKE @q OR company LIKE @q OR message LIKE @q)'); params.q = `%${q}%`; }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM leads ${w}`).get(params).c;
  const rows = db.prepare(`SELECT * FROM leads ${w} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset: (page - 1) * limit });
  res.json({ total, page, limit, data: rows });
});

app.get('/api/admin/leads/export.csv', auth, (req, res) => {
  const rows = db.prepare('SELECT id,name,email,phone,company,service,budget,message,status,created_at FROM leads ORDER BY id DESC').all();
  const cols = ['id', 'name', 'email', 'phone', 'company', 'service', 'budget', 'message', 'status', 'created_at'];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv').attachment('leads.csv').send([cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n'));
});

app.patch('/api/admin/leads/:id', auth, validate(z.object({ status: z.enum(STATUSES).optional(), notes: z.string().max(5000).optional() })), (req, res) => {
  const d = req.body; const keys = Object.keys(d);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
  const info = db.prepare(`UPDATE leads SET ${keys.map(k => `${k}=@${k}`).join(',')} WHERE id=@id`).run({ ...d, id: req.params.id });
  info.changes ? res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/admin/leads/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  info.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});

app.get('/api/admin/subscribers', auth, (req, res) => res.json(db.prepare('SELECT * FROM subscribers ORDER BY id DESC').all()));
app.delete('/api/admin/subscribers/:id', auth, (req, res) => { db.prepare('DELETE FROM subscribers WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/admin/stats', auth, (req, res) => {
  const count = (t, w = '1=1') => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`).get().c;
  res.json({
    leads: count('leads'),
    leadsLast7Days: count('leads', "created_at >= datetime('now','-7 days')"),
    byStatus: db.prepare('SELECT status, COUNT(*) count FROM leads GROUP BY status').all(),
    byService: db.prepare("SELECT service, COUNT(*) count FROM leads WHERE service != '' GROUP BY service ORDER BY count DESC").all(),
    subscribers: count('subscribers'), posts: count('posts'), projects: count('projects'),
  });
});

// ---------- errors ----------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

app.listen(PORT, () => console.log(`ALLIVER API running on :${PORT}`));
