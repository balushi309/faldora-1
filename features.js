// التكتات + التفعيل + نشر القوانين
const crypto = require('crypto');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags, ChannelType, PermissionsBitField: P,
} = require('discord.js');
const { db, save, log, embed, config, rankLevel, isLadderRole, isDangerous } = require('./core');

const row = (...b) => new ActionRowBuilder().addComponents(...b);
const button = (id, label, style = ButtonStyle.Primary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const uid = () => crypto.randomBytes(6).toString('hex');
const private_ = content => ({ content, flags: MessageFlags.Ephemeral });

async function sendTicketPanel(channel) {
  const types = config(channel.guild.id).ticketTypes.slice(0, 5);
  await channel.send({
    embeds: [embed('🎫 التكتات', 'اختر نوع التكت من الأزرار تحت')],
    components: [row(...types.map((t, i) => button(`ticket:open:${i}`, t.slice(0, 80))))],
  });
}

async function sendVerifyPanel(channel) {
  await channel.send({
    embeds: [embed('✅ التفعيل', 'اضغط الزر وعبّي الطلب، وبيتم الرد عليك من الإدارة.', 0x22c55e)],
    components: [row(button('verify:start', 'تقديم تفعيل', ButtonStyle.Success))],
  });
}

async function publishRule(channel, rule) {
  // نقسم القانون الطويل على أكثر من رسالة
  const parts = rule.body.match(/[\s\S]{1,3900}/g) || [];
  for (let i = 0; i < parts.length; i++)
    await channel.send({ embeds: [embed(i ? `${rule.title} (تابع)` : `📜 ${rule.title}`, parts[i])], allowedMentions: { parse: [] } });
}

const ticketStaffRoles = guild => config(guild.id).ranks
  .filter(r => r.perms.includes('tickets') && guild.roles.cache.has(r.roleId)).map(r => r.roleId);

const opening = new Set();
async function openTicket(i, typeIndex) {
  const g = i.guild, cfg = config(g.id), key = `${g.id}:${i.user.id}`;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const mine = Object.values(db.tickets).find(t => t.g === g.id && t.userId === i.user.id && t.open && g.channels.cache.has(t.channelId));
  if (mine) return i.editReply(`عندك تكت مفتوح: <#${mine.channelId}>`);
  if (opening.has(key)) return i.editReply('جاري فتح التكت...');
  opening.add(key);
  try {
    const type = cfg.ticketTypes[typeIndex] || 'تكت';
    const allow = [P.Flags.ViewChannel, P.Flags.SendMessages, P.Flags.ReadMessageHistory, P.Flags.AttachFiles];
    const id = uid();
    const ch = await g.channels.create({
      name: `ticket-${i.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: g.channels.cache.has(cfg.ticketCategoryId) ? cfg.ticketCategoryId : undefined,
      permissionOverwrites: [
        { id: g.id, deny: [P.Flags.ViewChannel] },
        { id: i.user.id, allow },
        { id: i.client.user.id, allow: [...allow, P.Flags.ManageChannels] },
        ...ticketStaffRoles(g).map(r => ({ id: r, allow })),
      ],
    });
    db.tickets[id] = { id, g: g.id, channelId: ch.id, userId: i.user.id, userTag: i.user.tag, type, open: true, at: Date.now() };
    save();
    await ch.send({
      content: `<@${i.user.id}>`, allowedMentions: { users: [i.user.id] },
      embeds: [embed(`🎫 ${type}`, 'اكتب مشكلتك وانتظر رد الإدارة.')],
      components: [row(button(`ticket:close:${id}`, '🔒 إغلاق التكت', ButtonStyle.Danger))],
    });
    await i.editReply(`✅ تم فتح التكت: <#${ch.id}>`);
    await log(g, '🎫 فتح تكت', `<@${i.user.id}> — ${type}`, 0x00cc66);
  } finally { opening.delete(key); }
}

async function closeTicket(guild, id, by) {
  const t = db.tickets[id];
  if (!t || t.g !== guild.id || !t.open) throw new Error('التكت مغلق أو غير موجود.');
  t.open = false; t.closedBy = by; t.closedAt = Date.now();
  const ch = guild.channels.cache.get(t.channelId);
  if (ch) {
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
    t.transcript = msgs ? [...msgs.values()].reverse().map(m =>
      `${m.author.tag}: ${m.content || (m.attachments.size ? '[مرفق]' : '[رسالة مضمنة]')}`) : [];
  }
  // نحتفظ بآخر 200 تكت مغلق
  Object.values(db.tickets).filter(x => !x.open).sort((a, b) => b.closedAt - a.closedAt)
    .slice(200).forEach(x => delete db.tickets[x.id]);
  save();
  if (ch) await ch.delete('إغلاق تكت');
  await log(guild, '🔒 إغلاق تكت', `صاحب التكت: <@${t.userId}> — ${t.type}\nبواسطة: <@${by}>`);
}

async function showVerifyForm(i) {
  const cfg = config(i.guild.id);
  if (!cfg.verifyRoleId) return i.reply(private_('التفعيل ما تم إعداده، كلم الإدارة.'));
  if (i.member.roles.cache.has(cfg.verifyRoleId)) return i.reply(private_('أنت مفعل من قبل ✅'));
  if (Object.values(db.applications).some(a => a.g === i.guild.id && a.userId === i.user.id && a.status === 'pending'))
    return i.reply(private_('طلبك قيد المراجعة.'));
  const modal = new ModalBuilder().setCustomId('verify:submit').setTitle('طلب تفعيل')
    .addComponents(...cfg.questions.slice(0, 5).map((q, n) => row(new TextInputBuilder()
      .setCustomId(`q${n}`).setLabel(q.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500))));
  await i.showModal(modal);
}

async function submitVerify(i) {
  if (Object.values(db.applications).some(a => a.g === i.guild.id && a.userId === i.user.id && a.status === 'pending'))
    return i.reply(private_('طلبك قيد المراجعة.'));
  const answers = config(i.guild.id).questions.slice(0, 5).map((q, n) => {
    let a = ''; try { a = i.fields.getTextInputValue(`q${n}`); } catch {}
    return { q, a };
  });
  const id = uid();
  db.applications[id] = { id, g: i.guild.id, userId: i.user.id, userTag: i.user.tag, answers, status: 'pending', at: Date.now() };
  save();
  await i.reply(private_('✅ تم إرسال طلبك.'));
  await log(i.guild, '📝 طلب تفعيل جديد', `<@${i.user.id}> (راجعه من الموقع)`);
}

async function reviewApplication(guild, id, accept, by, reason) {
  const a = db.applications[id];
  if (!a || a.g !== guild.id || a.status !== 'pending') throw new Error('الطلب تمت مراجعته أو غير موجود.');
  a.status = 'processing';
  try {
    const m = await guild.members.fetch(a.userId).catch(() => null);
    if (accept) {
      if (!m) throw new Error('العضو طلع من السيرفر، ارفض الطلب.');
      const roleId = config(guild.id).verifyRoleId, role = guild.roles.cache.get(roleId);
      if (!role || isLadderRole(guild.id, roleId) || isDangerous(role)) throw new Error('رتبة التفعيل غير صالحة، عدلها من الإعدادات.');
      await m.roles.add(role);
    }
    Object.assign(a, { status: accept ? 'accepted' : 'rejected', by, reason, reviewedAt: Date.now() });
    save();
    await m?.send(accept ? `✅ تم تفعيلك في **${guild.name}**` : `❌ انرفض طلب تفعيلك في **${guild.name}**\nالسبب: ${reason || 'بدون سبب'}`).catch(() => {});
    await log(guild, accept ? '✅ قبول تفعيل' : '❌ رفض تفعيل', `<@${a.userId}> بواسطة <@${by}>${reason ? `\nالسبب: ${reason}` : ''}`, accept ? 0x00cc66 : 0xff3333);
  } catch (e) {
    if (a.status === 'processing') { a.status = 'pending'; save(); }
    throw e;
  }
}

function registerInteractions(client) {
  client.on('interactionCreate', async i => {
    if (!i.guild || !(i.isButton() || i.isModalSubmit())) return;
    const [kind, action, arg] = i.customId.split(':');
    try {
      if (kind === 'ticket' && action === 'open') return await openTicket(i, Number(arg));
      if (kind === 'ticket' && action === 'close') {
        const t = db.tickets[arg];
        if (!t) return await i.reply(private_('التكت غير موجود.'));
        const level = rankLevel(i.member);
        const staff = level >= 0 && config(i.guild.id).ranks[level].perms.includes('tickets');
        if (i.user.id !== t.userId && !staff && i.user.id !== process.env.OWNER_ID)
          return await i.reply(private_('❌ ما عندك صلاحية.'));
        await i.reply(private_('جاري إغلاق التكت...'));
        return await closeTicket(i.guild, arg, i.user.id);
      }
      if (kind === 'verify' && action === 'start') return await showVerifyForm(i);
      if (kind === 'verify' && action === 'submit') return await submitVerify(i);
    } catch (e) {
      console.error(e);
      const msg = private_('❌ صار خطأ، تأكد من صلاحيات البوت.');
      await (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)).catch(() => {});
    }
  });
}

module.exports = { registerInteractions, sendTicketPanel, sendVerifyPanel, publishRule, closeTicket, reviewApplication };
