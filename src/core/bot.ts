import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { type Config } from './config.js';
import { type BotModule } from './module.js';
import { logger } from './logger.js';
import { startHealthServer, stopHealthServer } from './health.js';
import { registerGuildSyncEvents, refreshAllGuildMembers } from '../modules/registration/guild-sync.js';

let client: Client;
let loadedModules: BotModule[] = [];

export async function start(config: Config, modules: BotModule[]): Promise<void> {
  loadedModules = modules;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });

  // Register event listeners from each module
  for (const mod of modules) {
    mod.registerEvents(client);
    logger.debug(`Registered events for module: ${mod.name}`);
  }

  // Route slash command interactions to the correct module
  const commandMap = new Map<string, BotModule>();
  for (const mod of modules) {
    for (const cmd of mod.commands) {
      commandMap.set(cmd.name, mod);
    }
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const mod = commandMap.get(interaction.commandName);
    if (!mod) {
      logger.warn(`No module found for command: ${interaction.commandName}`);
      return;
    }

    try {
      await mod.handleCommand(interaction);
    } catch (err) {
      logger.error(`Error handling command /${interaction.commandName}`, {
        error: err instanceof Error ? err.message : String(err),
        module: mod.name,
      });
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'An error occurred.', flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: 'An error occurred.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Login
  client.once(Events.ClientReady, async (readyClient) => {
    const guilds = readyClient.guilds.cache.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount }));
    logger.info(`Bot online as ${readyClient.user.tag}`, {
      modules: modules.map((m) => m.name),
      guildCount: guilds.length,
      guilds,
    });

    // Register slash commands with Discord
    await registerCommands(config.discordToken, readyClient.user.id, modules);

    // Start health endpoint
    startHealthServer(config.healthPort, modules.map((m) => m.name));

    // Register guild member sync events and refresh caches for all active registrations
    registerGuildSyncEvents(readyClient);
    await refreshAllGuildMembers(readyClient);

    // Call onReady on each module
    for (const mod of modules) {
      if (mod.onReady) {
        await mod.onReady(readyClient);
      }
    }
  });

  await client.login(config.discordToken);
}

async function registerCommands(token: string, clientId: string, modules: BotModule[]): Promise<void> {
  const commands = modules.flatMap((mod) => mod.commands.map((cmd) => cmd.toJSON()));

  if (commands.length === 0) {
    logger.info('No commands to register');
    return;
  }

  const rest = new REST().setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    logger.info(`Registered ${commands.length} global command(s)`);
  } catch (err) {
    logger.error('Failed to register commands', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  for (const mod of loadedModules) {
    if (mod.onShutdown) {
      try {
        await mod.onShutdown();
        logger.info(`Module ${mod.name} shut down`);
      } catch (err) {
        logger.error(`Error shutting down module ${mod.name}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await stopHealthServer();

  if (client) {
    client.destroy();
    logger.info('Discord client destroyed');
  }
}
