import Fastify from 'fastify';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from '@fastify/cors';

dotenv.config();
const fastify = Fastify();

await fastify.register(cors, {
    origin: '*',
    methods: ['GET'],
});

const SPOTIFY_CONFIG = {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
};

class SpotifyManager {
    constructor() {
        this.accessToken = null;
        this.cache = { playing: false };
        this.lastUpdated = 0;
        this.isUpdating = false;
        this.updateQueue = [];
    }

    async refreshToken() {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: SPOTIFY_CONFIG.refreshToken,
                client_id: SPOTIFY_CONFIG.clientId,
                client_secret: SPOTIFY_CONFIG.clientSecret,
            }),
        });

        const data = await response.json();
        if (data.access_token) {
            this.accessToken = data.access_token;
        }
    }

    async updateTrack() {
        if (this.isUpdating) return new Promise(resolve => this.updateQueue.push(resolve));
        
        this.isUpdating = true;
        try {
            const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
                headers: { Authorization: `Bearer ${this.accessToken}` },
            });

            if (response.status === 401) {
                await this.refreshToken();
                return this.updateTrack();
            }

            if (response.status === 204 || !response.ok) {
                this.cache = { playing: false };
            } else {
                const data = await response.json();
                if (!data.item) {
                    this.cache = { playing: false };
                } else {
                    this.cache = {
                        playing: true,
                        name: data.item.name,
                        artist: data.item.artists.map(a => a.name).join(', '),
                        albumCover: data.item.album.images[0]?.url || null,
                    };
                }
            }
            this.lastUpdated = Date.now();
        } catch {
            this.cache = { playing: false };
        } finally {
            this.isUpdating = false;
            while (this.updateQueue.length) this.updateQueue.shift()();
        }
        return this.cache;
    }
}

class WeatherManager {
    constructor() {
        this.cache = null;
        this.lastUpdated = 0;
        this.isUpdating = false;
    }

    async update() {
        if (this.isUpdating) return;
        this.isUpdating = true;

        try {
            const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent('Irkutsk, RU')}&units=metric&lang=ru&appid=${process.env.WEATHER_API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();

            if (data.cod === 200) {
                this.cache = {
                    description: data.weather[0].description,
                    temp: data.main.temp.toFixed(1),
                };
                this.lastUpdated = Date.now();
            }
        } catch {
            this.cache = null;
        } finally {
            this.isUpdating = false;
        }
    }
}

const spotify = new SpotifyManager();
const weather = new WeatherManager();

await spotify.refreshToken();
await spotify.updateTrack();
await weather.update();

setInterval(() => spotify.refreshToken(), 2_700_000);
setInterval(() => spotify.updateTrack(), 15_000);
setInterval(() => weather.update(), 2_700_000);

fastify.get('/spotify', async (req, reply) => {
    if (Date.now() - spotify.lastUpdated > 15_000) {
        await spotify.updateTrack();
    }
    reply.header('Content-Security-Policy', "img-src 'self' data: https://i.scdn.co;");
    reply.send(spotify.cache);
});

fastify.get('/weather', async (req, reply) => {
    if (Date.now() - weather.lastUpdated > 2_700_000) {
        await weather.update();
    }
    reply.send(weather.cache || { error: 'Ошибка получения данных' });
});

fastify.get('/health', (req, reply) => {
    reply.send({ 
        status: 'ok',
        timestamp: Date.now(),
        spotify: {
            lastUpdated: spotify.lastUpdated,
            status: spotify.accessToken ? 'authenticated' : 'unauthenticated'
        },
        weather: {
            lastUpdated: weather.lastUpdated,
            status: weather.cache ? 'ok' : 'error'
        }
    });
});

fastify.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
    if (err) process.exit(1);
});