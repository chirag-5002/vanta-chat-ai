import { Client, GatewayIntentBits, ActivityType } from 'discord.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SYSTEM_INSTRUCTION_FILE = process.env.SYSTEM_INSTRUCTION_FILE || './systemInstruction.txt';

if (!DISCORD_TOKEN) {
    console.error('CRITICAL ERROR: DISCORD_TOKEN is not defined in the environment variables.');
    process.exit(1);
}

if (!GEMINI_API_KEY) {
    console.error('CRITICAL ERROR: GEMINI_API_KEY is not defined in the environment variables.');
    process.exit(1);
}

// Read system instructions
let systemInstruction = '';
try {
    const resolvedPath = path.resolve(SYSTEM_INSTRUCTION_FILE);
    if (fs.existsSync(resolvedPath)) {
        systemInstruction = fs.readFileSync(resolvedPath, 'utf8');
        console.log(`Loaded system instructions from ${resolvedPath} (${systemInstruction.length} chars)`);
    } else {
        console.warn(`WARNING: System instruction file not found at ${resolvedPath}. Bot will run without custom FAQs.`);
    }
} catch (err) {
    console.error('Error reading system instruction file:', err);
}

// Parse allowed channels
const allowedChannels = process.env.ALLOWED_CHANNELS
    ? process.env.ALLOWED_CHANNELS.split(',').map(id => id.trim()).filter(id => id.length > 0)
    : [];

if (allowedChannels.length > 0) {
    console.log(`Allowed channels configured: ${allowedChannels.join(', ')}`);
} else {
    console.log('No allowed channels configured. Bot will ONLY respond when directly mentioned.');
}

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: systemInstruction,
});

// Cache for storing chat history sessions in-memory
// Key: channelId or threadId, Value: { history: Array, lastActive: number }
const chatSessions = new Map();
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes session expiry

// Periodic cleanup of inactive chat sessions to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of chatSessions.entries()) {
        if (now - session.lastActive > SESSION_TIMEOUT_MS) {
            chatSessions.delete(key);
            console.log(`Cleaned up expired chat session for channel/thread: ${key}`);
        }
    }
}, 5 * 60 * 1000); // Run cleanup every 5 minutes

// Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', () => {
    console.log(`=== Bot is Online as ${client.user.tag} ===`);
    client.user.setActivity('chat | Mention me for help!', { type: ActivityType.Watching });
});

client.on('messageCreate', async (message) => {
    // Ignore bot messages to prevent infinite loops
    if (message.author.bot) return;

    // Check if the bot was mentioned
    const isMentioned = message.mentions.has(client.user.id);
    // Check if message is in one of the allowed Q&A channels
    const isInAllowedChannel = allowedChannels.includes(message.channel.id);

    // Only respond if mentioned OR in a designated auto-response channel
    if (!isMentioned && !isInAllowedChannel) return;

    try {
        // Trigger Discord typing status so users know the bot is generating an answer
        await message.channel.sendTyping();

        // Extract and clean the prompt (remove bot mention if any)
        let promptText = message.content;
        const botMentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
        promptText = promptText.replace(botMentionRegex, '').trim();

        // If the message was just a mention with no question, reply with a helper
        if (promptText.length === 0) {
            await message.reply(`Hey <@${message.author.id}>, I am the AI Assistant. How can I help you today? Ask me about trading, tickets, or server rules!`);
            return;
        }

        // Format the prompt with user identity so Gemini can prepend "Hey <@userId>," as instructed
        const prompt = `[User: ${message.author.username} (ID: ${message.author.id})]: ${promptText}`;

        // Get or initialize chat session for this channel/thread
        const sessionId = message.channel.id;
        let session = chatSessions.get(sessionId);
        const now = Date.now();

        if (!session || (now - session.lastActive > SESSION_TIMEOUT_MS)) {
            session = {
                history: [],
                lastActive: now
            };
            chatSessions.set(sessionId, session);
            console.log(`Initialized new chat session for channel/thread: ${sessionId}`);
        } else {
            session.lastActive = now;
        }

        // Start Gemini chat session with existing history
        const chat = model.startChat({
            history: session.history,
            generationConfig: {
                maxOutputTokens: 800,
                temperature: 0.7,
            }
        });

        // Send message to Gemini and await response
        const result = await chat.sendMessage(prompt);
        const responseText = result.response.text().trim();

        // Save updated history
        session.history = await chat.getHistory();
        session.lastActive = Date.now();

        // If response is empty or invalid
        if (!responseText) {
            await message.reply("I'm sorry, I couldn't formulate a response. Please try again.");
            return;
        }

        // Split response into chunks if it exceeds Discord's 2000 character limit
        if (responseText.length <= 2000) {
            await message.reply({
                content: responseText,
                allowedMentions: { repliedUser: true }
            });
        } else {
            const chunks = chunkString(responseText, 1900);
            for (let i = 0; i < chunks.length; i++) {
                if (i === 0) {
                    await message.reply({
                        content: chunks[i],
                        allowedMentions: { repliedUser: true }
                    });
                } else {
                    await message.channel.send(chunks[i]);
                }
            }
        }

    } catch (error) {
        console.error('Error handling message through Gemini AI:', error);
        try {
            await message.reply("⚠️ Sorry, I encountered an error while processing your request. Please try again later or open a support ticket.");
        } catch (discordErr) {
            console.error('Could not send error reply to Discord:', discordErr);
        }
    }
});

// Helper function to split text into chunks
function chunkString(str, size) {
    const numChunks = Math.ceil(str.length / size);
    const chunks = new Array(numChunks);
    for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
        chunks[i] = str.substr(o, size);
    }
    return chunks;
}

// Start the client
client.login(DISCORD_TOKEN);
