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
  const { botToken, guildId, notifyChannelId } = config.discord;
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

  client.once(Events.ClientReady, async (c) => {
    console.log(`[bot] Conectado como ${c.user.tag}`);
    try {
      if (guildId) {
        await c.application.commands.set(commands, guildId);
      } else {
        await c.application.commands.set(commands);
      }
      console.log('[bot] Comando /live registrado.');
    } catch (err) {
      console.error('[bot] Falha ao registrar comandos:', err.message);
    }
    updatePresence().catch(() => {});
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'live') return;
    try {
      await interaction.reply({ embeds: [await statusEmbed()], components: [watchButton()] });
    } catch (err) {
      console.error('[bot] /live:', err.message);
    }
  });

  async function notifyChannel() {
    if (!notifyChannelId || !client.isReady()) return null;
    try {
      const channel = await client.channels.fetch(notifyChannelId);
      return channel?.isTextBased() ? channel : null;
    } catch (err) {
      console.error('[bot] Canal de avisos inválido:', err.message);
      return null;
    }
  }

  liveEvents.on('stream:start', async ({ identity, name }) => {
    updatePresence().catch(() => {});
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

  liveEvents.on('stream:end', async ({ identity, name }) => {
    updatePresence().catch(() => {});
    const msg = notifications.get(identity);
    if (!msg) return;
    notifications.delete(identity);
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
