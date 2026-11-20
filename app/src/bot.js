import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from './config.js';
import { getRoomState, liveEvents } from './livekit.js';

const COLOR_LIVE = 0xed4245;
const COLOR_IDLE = 0x5865f2;
const COLOR_ENDED = 0x4f545c;

function watchButton(label = 'Assistir agora') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(config.publicUrl).setEmoji('📺'),
  );
}

async function statusEmbed() {
  const state = await getRoomState();
  const live = state.streamers.filter((s) => s.live);
  const embed = new EmbedBuilder()
    .setTitle('Faz o L')
    .setURL(config.publicUrl)
    .setColor(live.length ? COLOR_LIVE : COLOR_IDLE);

  if (live.length) {
    embed.setDescription(live.map((s) => `🔴 **${s.name}** está ao vivo`).join('\n'));
  } else {
    embed.setDescription('Ninguém transmitindo agora. Entre no site e seja o primeiro!');
  }
  embed.addFields(
    { name: 'Transmitindo', value: `${live.length}/${state.maxStreamers}`, inline: true },
    { name: 'Assistindo', value: `${state.viewers}/${state.maxViewers}`, inline: true },
  );
  return embed;
}

export async function startBot() {
  const { botToken, guildId, notifyChannelId, clipsChannelId } = config.discord;
  if (!botToken) {
    console.log('[bot] DISCORD_BOT_TOKEN não definido — bot desativado.');
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const notifications = new Map(); // identity -> Message

  const commands = [
    new SlashCommandBuilder().setName('live').setDescription('Mostra quem está transmitindo e o link para assistir'),
  ].map((c) => c.toJSON());

  async function updatePresence() {
    if (!client.isReady()) return;
    const state = await getRoomState();
    const live = state.streamers.filter((s) => s.live).length;
    client.user.setPresence({
      status: live ? 'online' : 'idle',
      activities: [
        {
          type: ActivityType.Watching,
          name: live ? `${live} ao vivo • ${state.viewers} assistindo` : 'ninguém ao vivo • /live',
        },
      ],
    });
  }

  async function registerCommands() {
    try {
      if (guildId) {
        await client.application.commands.set(commands, guildId);
      } else {
        await client.application.commands.set(commands);
      }
      console.log('[bot] Comando /live registrado.');
    } catch (err) {
      if (guildId && err.code === 50001) {
        console.log('[bot] O bot ainda não está no servidor. Convide-o:');
        console.log(`[bot]   https://discord.com/oauth2/authorize?client_id=${client.application.id}&scope=bot+applications.commands&permissions=19456`);
      } else {
        console.error('[bot] Falha ao registrar comandos:', err.message);
      }
    }
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(`[bot] Conectado como ${c.user.tag}`);
    await registerCommands();
    updatePresence().catch(() => {});
  });

  // Convidado pro servidor depois de ligado: registra o /live na hora, sem reiniciar
  client.on(Events.GuildCreate, (guild) => {
    console.log(`[bot] Entrou no servidor ${guild.name}`);
    if (!guildId || guild.id === guildId) registerCommands();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'live') return;
    try {
      await interaction.reply({ embeds: [await statusEmbed()], components: [watchButton()] });
    } catch (err) {
      console.error('[bot] /live:', err.message);
    }
  });

  async function textChannel(id, label) {
    if (!id || !client.isReady()) return null;
    try {
      const channel = await client.channels.fetch(id);
      return channel?.isTextBased() ? channel : null;
    } catch (err) {
      console.error(`[bot] Canal de ${label} inválido:`, err.message);
      return null;
    }
  }
  const notifyChannel = () => textChannel(notifyChannelId, 'avisos');

  /**
   * Nome de exibição no Discord. Se só tivermos o id (identity "d<id>" ou
   * "d<id>:tela"), busca o usuário no servidor: apelido > nome global > username.
   */
  async function resolveName(identity, name) {
    const match = /^d(\d+)(?::tela)?$/.exec(identity || '');
    if (!match || (name && name !== identity && name !== identity.replace(/:tela$/, ''))) return name;
    const userId = match[1];
    try {
      if (guildId) {
        const member = await client.guilds.cache.get(guildId)?.members.fetch(userId);
        if (member) return member.displayName;
      }
      const user = await client.users.fetch(userId);
      return user.globalName || user.username;
    } catch {
      return name || 'alguém';
    }
  }

  // Cada clipe novo vai pro canal de clipes; o link abre o vídeo embutido no Discord
  liveEvents.on('clip:created', async (clip) => {
    const channel = await textChannel(clipsChannelId || notifyChannelId, 'clipes');
    if (!channel) return;
    const [streamer, creator] = await Promise.all([
      resolveName(clip.streamerIdentity, clip.streamerName),
      resolveName(clip.creatorId, clip.creatorName),
    ]);
    const length = clip.seconds >= 60 ? `${clip.seconds / 60} min` : `${clip.seconds} s`;
    const who = creator === streamer ? `**${creator}** clipou a própria live` : `**${creator}** clipou a live de **${streamer}**`;
    try {
      await channel.send({
        content: `✂️ ${who} (${length})\n${config.publicUrl}/clip/${clip.id}`,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('[bot] Falha ao postar clipe:', err.message);
    }
  });

  liveEvents.on('stream:start', async ({ identity, name: rawName }) => {
    updatePresence().catch(() => {});
    const name = await resolveName(identity, rawName);
    const channel = await notifyChannel();
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(COLOR_LIVE)
      .setTitle(`🔴 ${name} está ao vivo!`)
      .setURL(config.publicUrl)
      .setDescription('Clique no botão para assistir com quase zero de delay.')
      .setTimestamp();
    try {
      const msg = await channel.send({ embeds: [embed], components: [watchButton()] });
      notifications.set(identity, msg);
    } catch (err) {
      console.error('[bot] Falha ao enviar aviso:', err.message);
    }
  });

  liveEvents.on('stream:end', async ({ identity, name: rawName }) => {
    updatePresence().catch(() => {});
    const msg = notifications.get(identity);
    if (!msg) return;
    notifications.delete(identity);
    const name = await resolveName(identity, rawName);
    const embed = new EmbedBuilder()
      .setColor(COLOR_ENDED)
      .setTitle(`${name} encerrou a transmissão`)
      .setTimestamp();
    msg.edit({ embeds: [embed], components: [] }).catch(() => {});
  });

  let presenceTimer;
  liveEvents.on('room:update', () => {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => updatePresence().catch(() => {}), 2000);
  });

  await client.login(botToken);
}
