// ============================================================
//  موقع التحكم بالبوت (الباك إند)
//  المتغيرات: OWNER_ID و DASH_PASSWORD (دخول المالك) | PORT | HOST
// ============================================================
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { ChannelType } = require('discord.js');
const { db, save, log, config, rankLevel, isLadderRole, isDangerous, PERMS } = require('./core');
const F = require('./features');

class Fail extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const need = (ok, msg, status) => { if (!ok) throw new Fail(msg, status); };
const isId = s => typeof s === 'string' && /^\d{15,25}$/.test(s);
const text = (s, max) => String(s ?? '').trim().slice(0, max);

const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(k))));
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

function startDashboard(client) {
  const OWNER = process.env.OWNER_ID, OWNER_PW = process.env.DASH_PASSWORD;
  if (!isId(OWNER) || !OWNER_PW || OWNER_PW.length < 8) {
    console.log('⚠️ الموقع ما اشتغل: حط OWNER_ID و DASH_PASSWORD (8 أحرف أو أكثر) في ملف .env');
    return;
  }
  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '127.0.0.1';

  const app = express();
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cdn.discordapp.com; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // مغلف يمسك الأخطاء ويرجعها برسالة واضحة
  const route = fn => async (req, res) => {
    try { res.json((await fn(req)) ?? { ok: true }); }
    catch (e) {
      if (!(e instanceof Fail)) console.error(e);
      res.status(e.status || 500).json({ error: e instanceof Fail ? e.message : 'فشل التنفيذ: تأكد من صلاحيات البوت ومن إن رتبته أعلى من الهدف.' });
    }
  };

  // ---------- الدخول ----------
  const sessions = new Map(); // token -> { id, exp }
  const fails = new Map();
  const dropSessions = id => sessions.forEach((s, t) => s.id === id && sessions.delete(t));

  // وصول المستخدم لسيرفر: المالك كل شي، والإداري حسب رتبته الحالية
  async function access(g, userId) {
    if (userId === OWNER) return { owner: true, level: Infinity, perms: Object.keys(PERMS), member: null };
    if (!db.accounts[userId]) return null;
    const member = await g.members.fetch(userId).catch(() => null);
    if (!member) return null;
    const level = rankLevel(member);
    if (level < 0) return null;
    return { owner: false, level, perms: config(g.id).ranks[level].perms, member };
  }
  const myGuilds = async userId => {
    const out = [];
    for (const g of client.guilds.cache.values()) if (await access(g, userId)) out.push(g);
    return out;
  };

  app.post('/api/login', route(async req => {
    const id = text(req.body?.id, 25), pw = String(req.body?.password ?? '').slice(0, 200);
    const keys = [`ip:${req.ip}`, `id:${id}`];
    need(!keys.some(k => fails.get(k)?.until > Date.now()), 'محاولات كثيرة، انتظر 5 دقايق.', 429);
    let ok = false;
    if (id === OWNER) ok = crypto.timingSafeEqual(sha(pw), sha(OWNER_PW));
    else {
      const acc = Object.hasOwn(db.accounts, id) ? db.accounts[id] : null;
      const key = await scrypt(pw, acc?.salt || 'none');
      ok = !!acc && crypto.timingSafeEqual(key, Buffer.from(acc.hash, 'hex'));
    }
    if (!ok) {
      for (const k of keys) {
        const f = fails.get(k) || { n: 0, until: 0 };
        if (++f.n >= (k.startsWith('ip') ? 15 : 5)) { f.until = Date.now() + 5 * 60e3; f.n = 0; }
        fails.set(k, f);
      }
      throw new Fail('الآيدي أو الباسورد غلط.', 401);
    }
    need((await myGuilds(id)).length, 'ما عندك رتبة إدارية.', 403);
    keys.forEach(k => fails.delete(k));
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { id, exp: Date.now() + 12 * 3600e3 });
    return { token };
  }));

  app.use('/api', (req, res, next) => {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    const s = sessions.get(t);
    if (!s || s.exp < Date.now()) { sessions.delete(t); return res.status(401).json({ error: 'سجل دخول.' }); }
    req.userId = s.id; req.token = t; next();
  });

  app.post('/api/logout', route(req => { sessions.delete(req.token); }));
  app.get('/api/me', route(async req => ({
    id: req.userId, owner: req.userId === OWNER, permNames: PERMS,
    guilds: (await myGuilds(req.userId)).map(g => ({ id: g.id, name: g.name, members: g.memberCount })),
  })));

  // ---------- حسابات الموقع (المالك فقط) ----------
  const ownerOnly = req => need(req.userId === OWNER, 'للمالك فقط.', 403);
  app.get('/api/accounts', route(req => {
    ownerOnly(req);
    return Object.entries(db.accounts).map(([id, a]) => ({ id, name: client.users.cache.get(id)?.tag || '', at: a.at }));
  }));
  app.post('/api/accounts', route(async req => {
    ownerOnly(req);
    const id = text(req.body.id, 25), pw = String(req.body.password ?? '');
    need(isId(id) && id !== OWNER, 'آيدي غير صحيح.');
    need(pw.length >= 8 && pw.length <= 200, 'الباسورد لازم 8 أحرف أو أكثر.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.accounts[id] = { salt, hash: (await scrypt(pw, salt)).toString('hex'), at: Date.now() };
    save(); dropSessions(id);
    for (const g of await myGuilds(id)) await log(g, '👤 حساب موقع (إضافة/تغيير باسورد)', `<@${id}> بواسطة <@${req.userId}>`);
  }));
  app.post('/api/accounts/delete', route(async req => {
    ownerOnly(req);
    const id = text(req.body.id, 25);
    need(Object.hasOwn(db.accounts, id), 'الحساب غير موجود.', 404);
    const guilds = await myGuilds(id);
    delete db.accounts[id]; save(); dropSessions(id);
    for (const g of guilds) await log(g, '👤 حذف حساب موقع', `<@${id}> بواسطة <@${req.userId}>`, 0xff3333);
  }));

  // ---------- كل ما يخص السيرفر ----------
  // perm = null يعني أي إداري، 'owner' يعني المالك فقط
  const guild = (perm, fn) => route(async req => {
    const g = client.guilds.cache.get(req.params.gid);
    need(g, 'السيرفر غير موجود.', 404);
    const me = await access(g, req.userId);
    need(me, 'ما عندك صلاحية على هذا السيرفر.', 403);
    if (perm === 'owner') need(me.owner, 'للمالك فقط.', 403);
    else if (perm) need([].concat(perm).some(p => me.perms.includes(p)), 'رتبتك ما تسمح بهذا.', 403);
    return fn(req, g, me);
  });
  const G = '/api/guilds/:gid';

  const textChannel = (g, me, id) => {
    const ch = g.channels.cache.get(id);
    need(ch && ch.type === ChannelType.GuildText, 'اختر روم نصي.');
    need(me.owner || ch.permissionsFor(me.member).has('ViewChannel'), 'ما تقدر تشوف هذا الروم.', 403);
    return ch;
  };

  app.get(`${G}/info`, guild(null, (req, g, me) => {
    const cfg = config(g.id);
    return {
      me: { owner: me.owner, perms: me.perms, rank: me.owner ? 'المالك' : g.roles.cache.get(cfg.ranks[me.level].roleId)?.name },
      roles: [...g.roles.cache.values()].filter(r => r.id !== g.id).sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, managed: r.managed, staff: isLadderRole(g.id, r.id) })),
      channels: [...g.channels.cache.values()]
        .filter(c => [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory].includes(c.type))
        .filter(c => me.owner || c.permissionsFor(me.member).has('ViewChannel'))
        .map(c => ({ id: c.id, name: c.name, type: c.type === ChannelType.GuildVoice ? 'voice' : c.type === ChannelType.GuildCategory ? 'category' : 'text' })),
    };
  }));

  app.get(`${G}/members`, guild(['mute', 'warn', 'unwarn', 'kick', 'ban', 'promote', 'roles', 'money'], async (req, g) => {
    const q = text(req.query.q, 50);
    const list = isId(q) ? [await g.members.fetch(q).catch(() => null)].filter(Boolean)
      : [...(await g.members.fetch({ query: q, limit: 25 })).values()];
    const cfg = config(g.id);
    return list.map(m => {
      const level = rankLevel(m);
      return {
        id: m.id, tag: m.user.tag, name: m.displayName, avatar: m.user.displayAvatarURL({ size: 64 }),
        muted: (m.communicationDisabledUntilTimestamp || 0) > Date.now(),
        roles: [...m.roles.cache.values()].filter(r => r.id !== g.id).map(r => r.name),
        warns: (db.warns[m.id] || []).length,
        rank: level >= 0 ? g.roles.cache.get(cfg.ranks[level].roleId)?.name : '',
        next: g.roles.cache.get(cfg.ranks[level + 1]?.roleId)?.name || '',
      };
    });
  }));

  app.get(`${G}/warns/:uid`, guild(['warn', 'unwarn'], req => db.warns[req.params.uid] || []));

  // ---------- أوامر الأعضاء ----------
  const promoting = new Set();
  const MEMBER_PERM = { mute: 'mute', unmute: 'mute', warn: 'warn', unwarn: 'unwarn', kick: 'kick', ban: 'ban', promote: 'promote', addrole: 'roles', removerole: 'roles', givemoney: 'money' };

  // رتبة عادية يسمح للإداري يتحكم فيها
  const checkRole = (g, me, role) => {
    need(role && role.id !== g.id && !role.managed, 'اختر رتبة صحيحة.');
    if (me.owner) return;
    need(!isLadderRole(g.id, role.id), 'الرتب الإدارية تنعطى بالترقية فقط.', 403);
    need(role.position < me.member.roles.highest.position && !isDangerous(role), 'ما تقدر تتحكم بهذي الرتبة.', 403);
  };

  app.post(`${G}/member`, guild(null, async (req, g, me) => {
    const { action, userId, roleId } = req.body;
    need(Object.hasOwn(MEMBER_PERM, action), 'أمر غير معروف.');
    need(me.perms.includes(MEMBER_PERM[action]), 'رتبتك ما تسمح بهذا.', 403);
    need(isId(userId), 'آيدي العضو غير صحيح.');
    const m = await g.members.fetch(userId).catch(() => null);
    need(m, 'العضو غير موجود.', 404);
    // الإداري ما يتحكم بنفسه ولا باللي بمستواه أو أعلى
    if (!me.owner) need(m.id !== req.userId && m.id !== g.ownerId && m.id !== OWNER && rankLevel(m) < me.level
      && m.roles.highest.position < me.member.roles.highest.position, 'ما تقدر تتحكم بهذا الشخص.', 403);

    const why = text(req.body.reason, 200) || 'بدون سبب';
    const val = parseInt(req.body.value, 10);
    const L = (title, desc, color) => log(g, `${title} (موقع)`, `${desc}\nبواسطة: <@${req.userId}>`, color);

    switch (action) {
      case 'mute': {
        const mins = Math.min(Math.max(val || 10, 1), 40320);
        await m.timeout(mins * 60e3, why);
        await L('🔇 ميوت', `${m} لمدة ${mins} دقيقة\nالسبب: ${why}`); break;
      }
      case 'unmute': await m.timeout(null); await L('🔊 فك ميوت', `${m}`, 0x00cc66); break;
      case 'kick': await m.kick(why); await L('👢 طرد', `${m.user.tag}\nالسبب: ${why}`); break;
      case 'ban': await m.ban({ reason: why }); await L('🔨 باند', `${m.user.tag}\nالسبب: ${why}`, 0xff3333); break;
      case 'warn': {
        const list = (db.warns[m.id] ??= []);
        list.push({ reason: why, by: req.userId, at: Date.now() }); save();
        await L('⚠️ تحذير', `${m}\nالسبب: ${why}\nالإجمالي: ${list.length}`);
        if (list.length === 3) await m.timeout(60 * 60e3, '3 تحذيرات').catch(() => {});
        break;
      }
      case 'unwarn': {
        const list = db.warns[m.id] || [];
        const i = list.findIndex(w => w.at === Number(req.body.at));
        need(i >= 0, 'التحذير غير موجود.', 404);
        const [w] = list.splice(i, 1);
        if (!list.length) delete db.warns[m.id];
        save(); await L('🧹 إزالة تحذير', `${m}\nالتحذير: ${w.reason}\nالباقي: ${list.length}`, 0x00cc66); break;
      }
      case 'promote': {
        const key = `${g.id}:${m.id}`;
        need(!promoting.has(key), 'الترقية قيد التنفيذ.', 409);
        promoting.add(key);
        try {
          const cfg = config(g.id), level = rankLevel(m), next = cfg.ranks[level + 1];
          need(cfg.ranks.length, 'المالك لازم يرتب الرتب الإدارية من الإعدادات.');
          need(next, 'العضو في أعلى رتبة.');
          need(me.owner || level + 1 < me.level, 'ما تقدر ترقي أحد لرتبتك أو أعلى.', 403);
          const role = g.roles.cache.get(next.roleId);
          need(role, 'الرتبة التالية محذوفة، عدل الإعدادات.');
          await m.roles.add(role);
          if (cfg.removeOld && level >= 0) await m.roles.remove(cfg.ranks[level].roleId);
          await L('⬆️ ترقية', `${m} ← <@&${role.id}>`, 0x00cc66);
          return { ok: true, rank: role.name };
        } finally { promoting.delete(key); }
      }
      case 'addrole':
      case 'removerole': {
        const role = g.roles.cache.get(roleId);
        checkRole(g, me, role);
        await m.roles[action === 'addrole' ? 'add' : 'remove'](role);
        await L(action === 'addrole' ? '➕ إعطاء رتبة' : '➖ إزالة رتبة', `${m} ← <@&${role.id}>`); break;
      }
      case 'givemoney': {
        const u = db.users[userId];
        need(u?.registered, 'العضو غير مسجل في نظام RP.');
        need(val, 'اكتب مبلغ.');
        u.cash = Math.max(0, u.cash + val); save();
        await L('💰 تعديل رصيد', `${m} (${val > 0 ? '+' : ''}${val}$)`, 0x00cc66); break;
      }
    }
  }));

  app.post(`${G}/unban`, guild('ban', async (req, g) => {
    need(isId(req.body.userId), 'آيدي غير صحيح.');
    await g.members.unban(req.body.userId);
    await log(g, '♻️ فك باند (موقع)', `ID: ${req.body.userId}\nبواسطة: <@${req.userId}>`, 0x00cc66);
  }));

  // ---------- حذف الرسائل ----------
  app.post(`${G}/purge`, guild('purge', async (req, g, me) => {
    const ch = textChannel(g, me, req.body.channelId);
    const n = Number(req.body.count);
    need(Number.isInteger(n) && n >= 1 && n <= 100, 'اكتب رقم من 1 إلى 100.');
    const deleted = await ch.bulkDelete(n, true); // رسائل أقدم من 14 يوم ما تنحذف (قيد ديسكورد)
    await log(g, '🧹 حذف رسائل (موقع)', `${deleted.size} رسالة في ${ch}\nبواسطة: <@${req.userId}>`);
    return { deleted: deleted.size };
  }));

  // ---------- الرومات ----------
  app.post(`${G}/channel`, guild(['channels', 'send'], async (req, g, me) => {
    const { action, channelId } = req.body;
    need(me.perms.includes(action === 'send' ? 'send' : 'channels'), 'رتبتك ما تسمح بهذا.', 403);
    const name = text(req.body.name, 100);
    const L = (t, d, c) => log(g, `${t} (موقع)`, `${d}\nبواسطة: <@${req.userId}>`, c);
    if (action === 'create') {
      need(name, 'اكتب الاسم.');
      await g.channels.create({ name, type: req.body.voice ? ChannelType.GuildVoice : ChannelType.GuildText });
      return void await L('🆕 إنشاء روم', name, 0x00cc66);
    }
    if (action === 'send') {
      const ch = textChannel(g, me, channelId), content = text(req.body.message, 1900);
      need(content, 'اكتب الرسالة.');
      await ch.send({ content, allowedMentions: { parse: [] } });
      return void await L('📨 إرسال رسالة', `${ch}\n${content}`);
    }
    const ch = g.channels.cache.get(channelId);
    need(ch && ch.type !== ChannelType.GuildCategory, 'الروم غير موجود.', 404);
    need(me.owner || ch.permissionsFor(me.member).has('ViewChannel'), 'ما تقدر تشوف هذا الروم.', 403);
    const old = ch.name;
    if (action === 'lock') await ch.permissionOverwrites.edit(g.roles.everyone, { SendMessages: false });
    else if (action === 'unlock') await ch.permissionOverwrites.edit(g.roles.everyone, { SendMessages: null });
    else if (action === 'rename') { need(name, 'اكتب الاسم.'); await ch.setName(name); }
    else if (action === 'slowmode') await ch.setRateLimitPerUser(Math.min(Math.max(parseInt(req.body.value, 10) || 0, 0), 21600));
    else if (action === 'delete') await ch.delete();
    else throw new Fail('أمر غير معروف.');
    const titles = { lock: '🔒 قفل روم', unlock: '🔓 فتح روم', rename: '✏️ تغيير اسم روم', slowmode: '⏱️ سلو مود', delete: '🗑️ حذف روم' };
    await L(titles[action], old);
  }));

  app.post(`${G}/role`, guild('roles', async (req, g, me) => {
    const L = (t, d) => log(g, `${t} (موقع)`, `${d}\nبواسطة: <@${req.userId}>`);
    if (req.body.action === 'create') {
      const name = text(req.body.name, 100);
      need(name, 'اكتب الاسم.');
      await g.roles.create({ name, permissions: [] });
      return void await L('🆕 إنشاء رتبة', name);
    }
    need(req.body.action === 'delete', 'أمر غير معروف.');
    const role = g.roles.cache.get(req.body.roleId);
    checkRole(g, me, role);
    await role.delete();
    await L('🗑️ حذف رتبة', role.name);
  }));

  // ---------- التكتات ----------
  app.get(`${G}/tickets`, guild('tickets', (req, g) =>
    Object.values(db.tickets).filter(t => t.g === g.id).sort((a, b) => b.at - a.at).slice(0, 100)));
  app.post(`${G}/tickets/close`, guild('tickets', async (req, g) => {
    need(db.tickets[req.body.id]?.open && db.tickets[req.body.id].g === g.id, 'التكت مغلق أو غير موجود.', 404);
    await F.closeTicket(g, req.body.id, req.userId);
  }));

  // ---------- التفعيل ----------
  app.get(`${G}/applications`, guild('verify', (req, g) =>
    Object.values(db.applications).filter(a => a.g === g.id)
      .sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || b.at - a.at).slice(0, 100)));
  app.post(`${G}/applications/review`, guild('verify', async (req, g) => {
    const a = db.applications[req.body.id];
    need(a && a.g === g.id && a.status === 'pending', 'الطلب تمت مراجعته أو غير موجود.', 404);
    need(a.userId !== req.userId, 'ما تقدر تراجع طلبك.', 403);
    await F.reviewApplication(g, a.id, req.body.accept === true, req.userId, text(req.body.reason, 200));
  }));

  // إرسال لوحة التكتات أو التفعيل لروم
  app.post(`${G}/panel`, guild('owner', async (req, g, me) => {
    const ch = textChannel(g, me, req.body.channelId);
    if (req.body.type === 'tickets') await F.sendTicketPanel(ch);
    else if (req.body.type === 'verify') { need(config(g.id).verifyRoleId, 'حدد رتبة التفعيل واحفظ أول.'); await F.sendVerifyPanel(ch); }
    else throw new Fail('نوع غير معروف.');
  }));

  // ---------- القوانين (أي إداري يقرأ، وصاحب الصلاحية يعدل) ----------
  app.get(`${G}/rules`, guild(null, (req, g) => db.rules[g.id] || []));
  app.post(`${G}/rules`, guild('rules', async (req, g, me) => {
    const list = (db.rules[g.id] ??= []);
    const { action, id } = req.body;
    const i = list.findIndex(r => r.id === id);
    if (action === 'save') {
      const title = text(req.body.title, 200), body = text(req.body.body, 15000);
      need(title && body, 'العنوان والنص مطلوبين.');
      if (id) { need(i >= 0, 'القانون غير موجود.', 404); Object.assign(list[i], { title, body }); }
      else list.push({ id: crypto.randomBytes(6).toString('hex'), title, body });
      save();
      return void await log(g, '📜 حفظ قانون', `${title}\nبواسطة: <@${req.userId}>`);
    }
    need(i >= 0, 'القانون غير موجود.', 404);
    if (action === 'delete') {
      const [r] = list.splice(i, 1); save();
      await log(g, '🗑️ حذف قانون', `${r.title}\nبواسطة: <@${req.userId}>`, 0xff3333);
    } else if (action === 'publish') {
      const ch = textChannel(g, me, req.body.channelId);
      await F.publishRule(ch, list[i]);
      await log(g, '📢 نشر قانون', `${list[i].title} في ${ch}\nبواسطة: <@${req.userId}>`);
    } else throw new Fail('أمر غير معروف.');
  }));

  // ---------- اللوقات ----------
  app.get(`${G}/logs`, guild('logs', (req, g) => {
    const q = text(req.query.q, 100).toLowerCase();
    // نحول المنشن لأسماء عشان تنقرأ في الموقع
    const pretty = s => s
      .replace(/<@&(\d+)>/g, (_, id) => '@' + (g.roles.cache.get(id)?.name || id))
      .replace(/<@!?(\d+)>/g, (_, id) => '@' + (g.members.cache.get(id)?.displayName || client.users.cache.get(id)?.username || id))
      .replace(/<#(\d+)>/g, (_, id) => '#' + (g.channels.cache.get(id)?.name || id));
    return db.logs.filter(l => l.g === g.id).reverse()
      .map(l => ({ title: l.title, desc: pretty(l.desc), at: l.at }))
      .filter(l => !q || (l.title + l.desc).toLowerCase().includes(q)).slice(0, 150);
  }));

  // ---------- الإعدادات (المالك فقط) ----------
  app.get(`${G}/settings`, guild('owner', (req, g) => config(g.id)));
  app.post(`${G}/settings`, guild('owner', async (req, g) => {
    const b = req.body;
    need(Array.isArray(b.ranks) && b.ranks.length <= 50, 'قائمة الرتب غير صحيحة.');
    const seen = new Set();
    const ranks = b.ranks.map(r => {
      const role = g.roles.cache.get(r?.roleId);
      need(role && role.id !== g.id && !role.managed && !seen.has(role.id), 'فيه رتبة إدارية غير صحيحة أو مكررة.');
      seen.add(role.id);
      return { roleId: role.id, perms: Array.isArray(r.perms) ? r.perms.filter(p => Object.hasOwn(PERMS, p)) : [] };
    });
    const verify = text(b.verifyRoleId, 25);
    if (verify) {
      const role = g.roles.cache.get(verify);
      need(role && verify !== g.id && !role.managed && !seen.has(verify) && !isDangerous(role), 'رتبة التفعيل لازم تكون رتبة عادية.');
    }
    const lines = (v, max, len) => (Array.isArray(v) ? v : []).map(s => text(s, len)).filter(Boolean).slice(0, max);
    const ticketTypes = lines(b.ticketTypes, 5, 80), questions = lines(b.questions, 5, 45);
    need(ticketTypes.length && questions.length, 'لازم نوع تكت واحد وسؤال تفعيل واحد على الأقل.');
    Object.assign(config(g.id), {
      ranks, removeOld: b.removeOld === true, verifyRoleId: verify, ticketTypes, questions,
      logChannelId: text(b.logChannelId, 25), ticketCategoryId: text(b.ticketCategoryId, 25),
    });
    save();
    await log(g, '⚙️ تعديل الإعدادات', `بواسطة: <@${req.userId}>`);
  }));

  app.listen(PORT, HOST, () => console.log(`🌐 الموقع: http://${HOST}:${PORT}`));
}

module.exports = { startDashboard };
