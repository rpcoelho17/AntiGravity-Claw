import { config } from "../config.js";
import { OpenAI, toFile } from "openai";
import * as googleTTS from "google-tts-api";

export async function transcribeAudio(audioBuffer: Buffer, mimeType: string = 'audio/ogg'): Promise<string> {
    // Groq provides an OpenAI-compatible endpoint
    const groq = new OpenAI({
        baseURL: "https://api.groq.com/openai/v1",
        apiKey: config.GROQ_API_KEY
    });

    // Telegram sends OGG Opus by default, we can parse it as 'voice.ogg'
    const file = await toFile(audioBuffer, 'voice.ogg', { type: mimeType });
    const response = await groq.audio.transcriptions.create({
        file: file,
        model: "whisper-large-v3-turbo",
    });
    return response.text;
}

export async function generateSpeech(text: string): Promise<Buffer> {
    // google-tts-api returns base64 encoded audio strings (MP3 format)
    const results = await googleTTS.getAllAudioBase64(text, {
        lang: 'en',
        slow: false,
        host: 'https://translate.google.com',
        timeout: 10000,
    });

    // Combine all base64 chunks into one single Buffer (MP3)
    const mp3Buffer = Buffer.concat(results.map(result => Buffer.from(result.base64, 'base64')));
    return mp3Buffer;
}
