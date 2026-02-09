import { Client, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export interface BotModule {
  name: string;
  commands: SlashCommandBuilder[];
  handleCommand(interaction: ChatInputCommandInteraction): Promise<void>;
  registerEvents(client: Client): void;
  onReady?(client: Client): Promise<void>;
  onShutdown?(): Promise<void>;
}
