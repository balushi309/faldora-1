// أدوات مشتركة بين البوت والموقع: قاعدة البيانات، اللوقات، الصلاحيات
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, PermissionsBitField: P } = require('discord.js');

const DB_FILE = path.join(__dirname, 'data.json');
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
for (const k of ['warns', 'users', 'accounts', 'config', 'tickets', 'applications', 'rules']) db[k] ??= {};
db.logs ??= [];

// كتابة آمنة: ملف مؤقت ثم استبدال (عشان ما يتلف الملف لو انطفى البوت)
const save = () => {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
};

const PERMS = {
  mute: 'ميوت وفك ميوت', warn: 'إعطاء تحذير', unwarn: 'إزالة تحذير', kick: 'طرد', ban: 'باند وفك باند',
  promote: 'ترقية الإدارة', roles: 'رتب عادية (إعطاء/إزالة/إنشاء/حذف)', money: 'تعديل الفلوس',
  purge: 'حذف الرسائل', channels: 'إدارة الرومات', send: 'إرسال رسائل', tickets: 'التكتات',
  verify: 'طلبات التفعيل', rules: 'القوانين', logs: 'مشاهدة اللوقات',
};

const config = gid => (db.config[gid] ??= {
  ranks: [],            // من الأقل للأعلى: { roleId, perms: [] }
  removeOld: false,     // شيل الرتبة السابقة عند الترقية
  logChannelId: '', ticketCategoryId: '', ticketTypes: ['دعم فني', 'شكوى'],
  verifyRoleId: '', questions: ['اسمك في الرول بلاي؟', 'كم عمرك؟', 'وش خبرتك في الرول بلاي؟'],
});

const embed = (title, desc, color = 0x2b8cff) =>
  new EmbedBuilder().setTitle(String(title).slice(0, 256)).setDescription(String(desc || '—').slice(0, 4000)).setColor(color).setTimestamp();

// كل لوق ينحفظ للموقع وينرسل لروم اللوقات في الديسكورد
async function log(guild, title, desc, color = 0xffaa00) {
  db.logs.push({ g: guild.id, title, desc: String(desc).slice(0, 2000), at: Date.now() });
  if (db.logs.length > 3000) db.logs.splice(0, db.logs.length - 3000);
  save();
  const id = config(guild.id).logChannelId;
  const ch = guild.channels.cache.get(id) || guild.channels.cache.find(c => c.name === 'logs' && c.isTextBased());
  if (ch) await ch.send({ embeds: [embed(title, desc, color)], allowedMentions: { parse: [] } }).catch(() => {});
}

// مستوى العضو في سلم الإدارة (-1 = مو إداري)
const rankLevel = (member, cfg = config(member.guild.id)) =>
  cfg.ranks.reduce((best, r, i) => (member.roles.cache.has(r.roleId) ? i : best), -1);

const isLadderRole = (gid, roleId) => config(gid).ranks.some(r => r.roleId === roleId);

const DANGEROUS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages',
  'ManageWebhooks', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone'];
const isDangerous = role => DANGEROUS.some(p => role.permissions.has(P.Flags[p], false));

module.exports = { db, save, log, embed, config, rankLevel, isLadderRole, isDangerous, PERMS };
