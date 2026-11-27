// ---------- أدوات ----------
const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else e[k] = v; }
  kids.flat().filter(k => k !== null && k !== false && k !== '').forEach(c => e.append(c instanceof Node ? c : String(c))); // نص فقط = آمن من XSS
  return e;
};
const btn = (label, cls, fn) => h('button', { type: 'button', class: cls, onclick: fn }, label);
const date = t => new Date(t).toLocaleString('ar');
let token = sessionStorage.getItem('t'), me = null, gid = null, info = null, tab = null, renderId = 0;

function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.style.borderColor = bad ? 'var(--red)' : 'var(--green)';
  t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 4000);
}
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') logout();
  if (!r.ok) throw new Error(data.error || 'خطأ');
  return data;
}
const G = p => `/api/guilds/${gid}/${p}`;
async function run(path, body, ok = '✅ تم') {
  try { const d = await api(G(path), body); toast(typeof ok === 'function' ? ok(d) : ok); await render(); }
  catch (e) { toast(e.message, true); }
}

// نافذة إدخال عامة
function ask(title, fields = [], okLabel = 'تنفيذ') {
  return new Promise(resolve => {
    const f = $('#dlgForm'), dlg = $('#dlg'), inputs = {};
    f.replaceChildren(h('h3', {}, title));
    for (const fd of fields) {
      let el;
      if (fd.type === 'select') el = h('select', {}, fd.options.map(([v, l]) => h('option', { value: v }, l)));
      else if (fd.type === 'textarea') el = h('textarea', { rows: fd.rows || 3 });
      else el = h('input', { type: fd.type || 'text' });
      if (fd.value !== undefined) el.value = fd.value;
      inputs[fd.name] = el; f.append(h('label', {}, fd.label), el);
    }
    f.append(h('div', { class: 'acts' }, h('button', { class: 'blue', value: 'ok' }, okLabel), h('button', { value: 'no', formNoValidate: true }, 'إلغاء')));
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])) : null);
    dlg.showModal();
  });
}
const chOpts = (type = 'text') => info.channels.filter(c => c.type === type).map(c => [c.id, c.name]);
const roleOpts = filter => info.roles.filter(r => !r.managed && filter(r)).map(r => [r.id, r.name]);
const can = (...p) => p.some(x => info.me.perms.includes(x));

// ---------- الدخول ----------
$('#login').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/api/login', { id: $('#uid').value.trim(), password: $('#pw').value });
    token = d.token; sessionStorage.setItem('t', token); $('#pw').value = ''; await start();
  } catch (x) { toast(x.message, true); }
};
function logout() { token = null; sessionStorage.removeItem('t'); $('#dlg').close(); $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#logout').onclick = async () => { await api('/api/logout', {}).catch(() => {}); logout(); };

async function start() {
  try {
    me = await api('/api/me');
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    $('#guild').replaceChildren(...me.guilds.map(g => h('option', { value: g.id }, `${g.name} (${g.members})`)));
    gid = me.guilds[0]?.id; tab = null;
    if (!gid) return toast('ما فيه سيرفرات.', true);
    await render();
  } catch (e) { toast(e.message, true); }
}
$('#guild').onchange = e => { gid = e.target.value; tab = null; render(); };

// ---------- التنقل ----------
const TABS = [
  ['members', '👥 الأعضاء', () => can('mute', 'warn', 'unwarn', 'kick', 'ban', 'promote', 'roles', 'money'), members],
  ['purge', '🧹 حذف الرسائل', () => can('purge'), purge],
  ['channels', '💬 الرومات', () => can('channels', 'send'), channels],
  ['roles', '🏷️ الرتب', () => can('roles'), roles],
  ['tickets', '🎫 التكتات', () => can('tickets'), tickets],
  ['verify', '✅ التفعيل', () => can('verify'), applications],
  ['rules', '📜 القوانين', () => true, rules],
  ['logs', '📋 اللوقات', () => can('logs'), logs],
  ['accounts', '🔑 مستخدمين الموقع', () => info.me.owner, accounts],
  ['settings', '⚙️ الإعدادات', () => info.me.owner, settings],
];
async function render() {
  const id = ++renderId, box = h('div', {}, '...');
  try {
    const fresh = await api(G('info'));
    if (id !== renderId) return;
    info = fresh;
    const shown = TABS.filter(t => t[2]());
    const cur = shown.find(t => t[0] === tab) || shown[0];
    tab = cur[0];
    $('#rank').textContent = 'رتبتك: ' + info.me.rank;
    $('#nav').replaceChildren(...shown.map(t => btn(t[1], t[0] === tab ? 'on' : '', () => { tab = t[0]; render(); })));
    $('#title').textContent = cur[1];
    $('#panel').replaceChildren(box);
    await cur[3](box);
  } catch (e) { if (id === renderId) { box.replaceChildren(e.message); $('#panel').replaceChildren(box); } }
}

// ---------- الأعضاء ----------
async function members(p) {
  const q = h('input', { placeholder: 'ابحث بالاسم أو الآيدي ثم Enter' });
  const list = h('div', { class: 'card' });
  const load = async () => {
    const ms = await api(G('members?q=' + encodeURIComponent(q.value.trim())));
    list.replaceChildren(...(ms.length ? ms.map(memberRow) : ['ما لقيت أحد.']));
  };
  const search = () => load().catch(e => toast(e.message, true));
  q.onkeydown = e => { if (e.key === 'Enter') search(); };
  p.replaceChildren(h('div', { class: 'bar' }, q, btn('🔍 بحث', 'blue', search),
    can('ban') && btn('♻️ فك باند', '', async () => { const v = await ask('فك باند', [{ name: 'userId', label: 'آيدي الشخص' }]); if (v) run('unban', { userId: v.userId.trim() }); })), list);
  await load();
}

function memberRow(m) {
  const send = (action, extra = {}, ok) => run('member', { action, userId: m.id, ...extra }, ok);
  const form = (action, title, fields) => async () => { const v = await ask(`${title}: ${m.name}`, fields); if (v) send(action, v); };
  const reason = [{ name: 'reason', label: 'السبب' }];
  const a = (perm, label, cls, fn) => can(perm) && btn(label, cls, fn);
  const showWarns = async () => {
    try {
      const list = await api(G('warns/' + m.id));
      if (!can('unwarn')) return ask(`تحذيرات ${m.name}`, [{ name: 'x', label: 'القائمة', type: 'textarea', rows: 6, value: list.map(w => w.reason).join('\n') }], 'تم');
      const v = await ask(`إزالة تحذير: ${m.name}`, [{ name: 'at', label: 'اختر التحذير', type: 'select', options: list.map(w => [w.at, `${w.reason} (${date(w.at)})`]) }], 'إزالة');
      if (v) send('unwarn', v, '✅ تم إزالة التحذير');
    } catch (e) { toast(e.message, true); }
  };
  return h('div', { class: 'row' },
    h('img', { src: m.avatar, alt: '' }),
    h('div', { class: 'info' }, m.name, h('small', {}, m.tag),
      m.rank && h('span', { class: 'tag staff' }, '🛡️ ' + m.rank),
      m.muted && h('span', { class: 'tag mute' }, 'ميوت'),
      m.warns > 0 && h('span', { class: 'tag' }, `${m.warns} تحذير`),
      m.roles.slice(0, 4).map(r => h('span', { class: 'tag' }, r))),
    h('div', { class: 'acts' },
      a('mute', '🔇 ميوت', 'orange', form('mute', 'ميوت', [{ name: 'value', label: 'المدة بالدقائق', type: 'number', value: 10 }, ...reason])),
      a('mute', '🔊 فك', '', () => send('unmute')),
      a('warn', '⚠️ تحذير', '', form('warn', 'تحذير', reason)),
      m.warns > 0 && can('warn', 'unwarn') && btn(can('unwarn') ? '🧹 إزالة تحذير' : '📄 التحذيرات', '', showWarns),
      m.next && a('promote', '⬆️ ترقية', 'blue', async () => { if (await ask(`ترقية ${m.name} إلى "${m.next}"؟`, [], 'ترقية')) send('promote', {}, d => `✅ صار ${d.rank}`); }),
      a('kick', '👢 طرد', 'orange', form('kick', 'طرد', reason)),
      a('ban', '🔨 باند', 'red', form('ban', 'باند', reason)),
      ['addrole', 'removerole'].map(act => a('roles', act === 'addrole' ? '➕ رتبة' : '➖ رتبة', act === 'addrole' ? 'green' : '', form(act, act === 'addrole' ? 'إعطاء رتبة' : 'إزالة رتبة',
        [{ name: 'roleId', label: 'الرتبة', type: 'select', options: roleOpts(r => info.me.owner || !r.staff) }]))),
      a('money', '💰 فلوس', '', form('givemoney', 'تعديل الرصيد', [{ name: 'value', label: 'المبلغ (سالب للخصم)', type: 'number' }]))));
}

// ---------- حذف الرسائل ----------
function purge(p) {
  const ch = h('select', {}, chOpts().map(([v, l]) => h('option', { value: v }, '# ' + l)));
  const n = h('input', { type: 'number', min: 1, max: 100, value: 5 });
  p.replaceChildren(h('div', { class: 'card' }, h('label', {}, 'الروم'), ch, h('label', {}, 'عدد الرسائل (1 - 100)'), n,
    h('p', { class: 'dim' }, 'ديسكورد ما يسمح بحذف جماعي لرسائل أقدم من 14 يوم.'),
    btn('🗑️ حذف الرسائل', 'red', async () => {
      const name = ch.selectedOptions[0]?.textContent;
      if (await ask(`حذف آخر ${n.value} رسالة من ${name}؟`, [], 'حذف')) run('purge', { channelId: ch.value, count: Number(n.value) }, d => `✅ انحذف ${d.deleted} رسالة`);
    })));
}

// ---------- الرومات والرتب ----------
function channels(p) {
  const send = (action, extra) => run('channel', { action, ...extra });
  const m = can('channels');
  p.replaceChildren(h('div', { class: 'bar' }, m && btn('➕ روم جديد', 'green', async () => {
    const v = await ask('روم جديد', [{ name: 'name', label: 'الاسم' }, { name: 'voice', label: 'النوع', type: 'select', options: [['', 'نصي'], ['1', 'صوتي']] }]);
    if (v) send('create', { name: v.name, voice: !!v.voice });
  })), h('div', { class: 'card' }, info.channels.filter(c => c.type !== 'category').map(c => {
    const form = (action, title, fields) => async () => { const v = await ask(`${title}: ${c.name}`, fields); if (v) send(action, { channelId: c.id, ...v }); };
    const text = c.type === 'text';
    return h('div', { class: 'row' }, h('div', { class: 'info' }, (text ? '# ' : '🔊 ') + c.name), h('div', { class: 'acts' },
      text && can('send') && btn('📨 رسالة', 'blue', form('send', 'إرسال رسالة', [{ name: 'message', label: 'النص', type: 'textarea' }])),
      text && m && [btn('🔒', '', () => send('lock', { channelId: c.id })), btn('🔓', '', () => send('unlock', { channelId: c.id })),
        btn('⏱️ سلو', '', form('slowmode', 'سلو مود', [{ name: 'value', label: 'ثواني (0 للإيقاف)', type: 'number', value: 0 }]))],
      m && [btn('✏️', '', form('rename', 'تغيير الاسم', [{ name: 'name', label: 'الاسم الجديد', value: c.name }])),
        btn('🗑️', 'red', async () => { if (await ask(`حذف ${c.name}؟`, [], 'حذف')) send('delete', { channelId: c.id }); })]));
  })));
}
function roles(p) {
  p.replaceChildren(h('div', { class: 'bar' }, btn('➕ رتبة جديدة', 'green', async () => {
    const v = await ask('رتبة جديدة', [{ name: 'name', label: 'الاسم' }]);
    if (v) run('role', { action: 'create', name: v.name });
  })), h('div', { class: 'card' }, info.roles.map(r => h('div', { class: 'row' },
    h('div', { class: 'info' }, r.name, r.managed && h('small', {}, 'رتبة بوت'), r.staff && h('small', {}, 'رتبة إدارية')),
    !r.managed && (info.me.owner || !r.staff) && btn('🗑️', 'red', async () => { if (await ask(`حذف ${r.name}؟`, [], 'حذف')) run('role', { action: 'delete', roleId: r.id }); })))));
}

// إرسال لوحة (أزرار) لروم في الديسكورد
const panelButton = (type, label) => info.me.owner && btn(label, 'blue', async () => {
  const v = await ask(label, [{ name: 'channelId', label: 'الروم', type: 'select', options: chOpts() }], 'إرسال');
  if (v) run('panel', { type, ...v });
});

// ---------- التكتات ----------
async function tickets(p) {
  const list = await api(G('tickets'));
  p.replaceChildren(h('div', { class: 'bar' }, panelButton('tickets', '📤 إرسال لوحة التكتات'), btn('🔄 تحديث', '', render)),
    h('div', { class: 'card' }, list.length ? list.map(t => h('div', { class: 'row' },
      h('div', { class: 'info' }, `${t.type} — ${t.userTag}`, h('small', {}, `${t.open ? '🟢 مفتوح' : '🔒 مغلق'} • ${date(t.at)}`),
        t.transcript && h('details', {}, h('summary', {}, 'المحادثة (آخر 100 رسالة)'), h('div', { class: 'pre' }, t.transcript.join('\n') || 'فاضية'))),
      t.open && btn('إغلاق', 'red', async () => { if (await ask('إغلاق التكت وحذف الروم؟', [], 'إغلاق')) run('tickets/close', { id: t.id }); }))) : 'ما فيه تكتات.'));
}

// ---------- التفعيل ----------
async function applications(p) {
  const list = await api(G('applications'));
  const STATUS = { pending: '🕓 بانتظار المراجعة', processing: '⏳ جاري التنفيذ', accepted: '✅ مقبول', rejected: '❌ مرفوض' };
  p.replaceChildren(h('div', { class: 'bar' }, panelButton('verify', '📤 إرسال لوحة التفعيل'), btn('🔄 تحديث', '', render)),
    ...(list.length ? list.map(a => h('div', { class: 'card' }, h('b', {}, a.userTag), h('div', { class: 'dim' }, `${STATUS[a.status]} • ${date(a.at)}`),
      a.answers.map(x => [h('label', { class: 'dim' }, x.q), h('div', { class: 'pre' }, x.a)]),
      a.status === 'pending' && h('div', { class: 'acts' },
        btn('✅ قبول', 'green', () => run('applications/review', { id: a.id, accept: true })),
        btn('❌ رفض', 'red', async () => { const v = await ask('رفض الطلب', [{ name: 'reason', label: 'السبب' }], 'رفض'); if (v) run('applications/review', { id: a.id, accept: false, ...v }); })))) : ['ما فيه طلبات.']));
}

// ---------- القوانين ----------
async function rules(p) {
  const list = await api(G('rules'));
  const edit = async (r = {}) => {
    const v = await ask(r.id ? 'تعديل قانون' : 'قانون جديد', [
      { name: 'title', label: 'العنوان (مثلاً: قوانين الرول بلاي)', value: r.title || '' },
      { name: 'body', label: 'نص القانون', type: 'textarea', rows: 10, value: r.body || '' }], 'حفظ');
    if (v) run('rules', { action: 'save', id: r.id, ...v });
  };
  const m = can('rules');
  p.replaceChildren(h('div', { class: 'bar' }, m && btn('➕ قانون جديد', 'green', () => edit())),
    ...(list.length ? list.map(r => h('div', { class: 'card' }, h('h3', {}, r.title), h('div', { class: 'pre' }, r.body),
      m && h('div', { class: 'acts' },
        btn('📢 نشر في روم', 'blue', async () => { const v = await ask(`نشر: ${r.title}`, [{ name: 'channelId', label: 'الروم', type: 'select', options: chOpts() }], 'نشر'); if (v) run('rules', { action: 'publish', id: r.id, ...v }); }),
        btn('✏️ تعديل', '', () => edit(r)),
        btn('🗑️ حذف', 'red', async () => { if (await ask(`حذف "${r.title}"؟`, [], 'حذف')) run('rules', { action: 'delete', id: r.id }); })))) : ['ما فيه قوانين.']));
}

// ---------- اللوقات ----------
async function logs(p) {
  const q = h('input', { placeholder: 'بحث في اللوقات ثم Enter' }), list = h('div', { class: 'card' });
  const load = async () => {
    const ls = await api(G('logs?q=' + encodeURIComponent(q.value)));
    list.replaceChildren(...(ls.length ? ls.map(l => h('div', { class: 'row' }, h('div', { class: 'info' }, h('b', {}, l.title), h('div', { class: 'pre' }, l.desc), h('small', {}, date(l.at))))) : ['ما فيه لوقات.']));
  };
  q.onkeydown = e => { if (e.key === 'Enter') load().catch(x => toast(x.message, true)); };
  p.replaceChildren(h('div', { class: 'bar' }, q, btn('🔄 تحديث', '', () => load().catch(x => toast(x.message, true)))), list);
  await load();
}

// ---------- مستخدمين الموقع ----------
async function accounts(p) {
  const list = await api('/api/accounts');
  const act = async (url, body) => { try { await api(url, body); toast('✅ تم'); render(); } catch (e) { toast(e.message, true); } };
  const setPw = async id => {
    const v = await ask(id ? 'تغيير الباسورد' : 'إضافة شخص', [
      ...(id ? [] : [{ name: 'id', label: 'آيدي الديسكورد' }]),
      { name: 'password', label: 'الباسورد (8 أحرف أو أكثر)', type: 'text' }], 'حفظ');
    if (v) act('/api/accounts', { id: (id || v.id).trim(), password: v.password });
  };
  p.replaceChildren(h('p', { class: 'dim' }, 'الشخص يقدر يدخل فقط إذا عنده حساب هنا + رتبة إدارية في السيرفر. صلاحياته حسب رتبته.'),
    h('div', { class: 'bar' }, btn('➕ إضافة شخص', 'green', () => setPw())),
    h('div', { class: 'card' }, list.length ? list.map(a => h('div', { class: 'row' },
      h('div', { class: 'info' }, a.name || a.id, h('small', {}, a.id)), h('div', { class: 'acts' },
        btn('🔑 تغيير الباسورد', '', () => setPw(a.id)),
        btn('🗑️ حذف', 'red', async () => { if (await ask('حذف الحساب؟', [], 'حذف')) act('/api/accounts/delete', { id: a.id }); })))) : 'ما أضفت أحد.'));
}

// ---------- الإعدادات ----------
async function settings(p) {
  const s = await api(G('settings'));
  const ranks = s.ranks.map(r => ({ roleId: r.roleId, perms: [...r.perms] }));
  const box = h('div');
  const draw = () => box.replaceChildren(...ranks.map((r, i) => {
    const move = d => { [ranks[i], ranks[i + d]] = [ranks[i + d], ranks[i]]; draw(); };
    return h('div', { class: 'card' }, h('div', { class: 'row' },
      h('div', { class: 'info' }, `${i + 1}. ${info.roles.find(x => x.id === r.roleId)?.name || 'رتبة محذوفة'}`),
      h('div', { class: 'acts' }, i > 0 && btn('⬆', '', () => move(-1)), i < ranks.length - 1 && btn('⬇', '', () => move(1)),
        btn('حذف', 'red', () => { ranks.splice(i, 1); draw(); }))),
      h('div', { class: 'checks' }, Object.entries(me.permNames).map(([k, l]) => h('label', {}, h('input', {
        type: 'checkbox', checked: r.perms.includes(k),
        onchange: e => { r.perms = e.target.checked ? [...r.perms, k] : r.perms.filter(x => x !== k); },
      }), ' ' + l))));
  }));
  draw();
  const select = (opts, value) => { const e = h('select', {}, [['', '— بدون —'], ...opts].map(([v, l]) => h('option', { value: v }, l))); e.value = value; return e; };
  const area = list => h('textarea', { rows: 5, value: list.join('\n') });
  const add = select(roleOpts(() => true), '');
  const logCh = select(chOpts(), s.logChannelId), cat = select(chOpts('category'), s.ticketCategoryId);
  const verify = select(roleOpts(() => true), s.verifyRoleId);
  const old = h('input', { type: 'checkbox', checked: s.removeOld });
  const types = area(s.ticketTypes), questions = area(s.questions);
  p.replaceChildren(
    h('h3', {}, '🛡️ الرتب الإدارية'), h('p', { class: 'dim' }, 'رتبها من الأقل (1) للأعلى، وحدد صلاحية كل رتبة.'), box,
    h('div', { class: 'bar' }, add, btn('➕ أضف للقائمة', 'green', () => {
      if (!add.value || ranks.some(r => r.roleId === add.value)) return;
      ranks.push({ roleId: add.value, perms: [] }); add.value = ''; draw();
    })),
    h('div', { class: 'card' },
      h('label', {}, old, ' شيل الرتبة السابقة عند الترقية'),
      h('label', {}, 'روم اللوقات (بدون = روم اسمه logs)'), logCh,
      h('label', {}, 'كاتيقوري التكتات'), cat,
      h('label', {}, 'أنواع التكتات (كل سطر نوع، أقصى 5)'), types,
      h('label', {}, 'رتبة التفعيل'), verify,
      h('label', {}, 'أسئلة التفعيل (كل سطر سؤال، أقصى 5، و45 حرف للسؤال)'), questions),
    btn('💾 حفظ الإعدادات', 'blue', () => run('settings', {
      ranks, removeOld: old.checked, logChannelId: logCh.value, ticketCategoryId: cat.value, verifyRoleId: verify.value,
      ticketTypes: types.value.split('\n'), questions: questions.value.split('\n'),
    }, '✅ انحفظت')));
}

if (token) start();
