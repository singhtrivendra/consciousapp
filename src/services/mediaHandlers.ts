import axios from 'axios';
import puppeteer from 'puppeteer-core'; // ✅ Use puppeteer-core for Render or AWS Lambda
import type { Browser } from 'puppeteer-core';

export interface YouTubeMetadata {
  title: string;
  description: string;
  thumbnailUrl: string;
}

export interface TwitterMetadata {
  text: string;
  author: string;
  mediaUrls: string[];
}

interface ContentMetadata {
  title: string;
  content: string;
  thumbnail: string | null;
}

// ---------- NOTE HANDLER ----------
export const handleNote = async (title: string, content: string): Promise<ContentMetadata> => {
  return {
    title: title || 'Untitled Note',
    content: content || '',
    thumbnail: null
  };
};

// ---------- YOUTUBE FETCH ----------
export const fetchYouTube = async (url: string): Promise<ContentMetadata> => {
  try {
    const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&]+)/)?.[1];
    if (!videoId) throw new Error('Invalid YouTube URL');

    const response = await axios.get(
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${process.env.YOUTUBE_API_KEY}&part=snippet`
    );

    const video = response.data.items[0]?.snippet;
    if (!video) throw new Error('YouTube metadata not found');

    return {
      title: video.title,
      content: `${video.description}\n\n${url}`,
      thumbnail: video.thumbnails.high?.url || null
    };
  } catch (error) {
    console.error('YouTube fetching error:', error);
    throw error;
  }
};

// ---------- TWITTER FETCH (Scraping) ----------
export const fetchTwitter = async (url: string): Promise<ContentMetadata> => {
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.waitForSelector('article div[data-testid="tweetText"]', { timeout: 30000 });

    const metadata = await page.evaluate(() => {
      const tweetText = document.querySelector('article div[data-testid="tweetText"]')?.textContent?.trim() || 'No tweet content';
      const author = document.querySelector('article a[role="link"] span')?.textContent?.trim() || 'Unknown';
      return { author, tweetText };
    });

    return {
      title: `Tweet by ${metadata.author}`,
      content: `${metadata.tweetText}\n\n${url}`,
      thumbnail: null,
    };
  } catch (error) {
    console.error('Twitter fetching error:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
};

// ---------- GENERIC WEBSITE FETCH ----------
export const fetchWebsite = async (url: string): Promise<ContentMetadata> => {
  const resolvedExecutablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: resolvedExecutablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--ignore-certificate-errors'
      ],
      timeout: 60000
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    await new Promise(res => setTimeout(res, 1500));

    return await page.evaluate(() => {
      const title = document.title || 'Untitled';
      const content = document.body?.innerText?.trim() || '';
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
      const firstImage = document.querySelector('img')?.getAttribute('src');
      const thumbnail = ogImage || firstImage || null;
      const absoluteUrl = thumbnail && !thumbnail.startsWith('http')
        ? new URL(thumbnail, window.location.origin).href
        : thumbnail;
      return { title, content, thumbnail: absoluteUrl };
    });
  } catch (error) {
    console.error('Website fetching error:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
};

// ---------- YOUTUBE METADATA (API) ----------
export async function getYoutubeMetadata(videoUrl: string): Promise<YouTubeMetadata> {
  const videoId = extractYoutubeVideoId(videoUrl);
  const API_KEY = process.env.YOUTUBE_API_KEY;
  
  try {
    const response = await axios.get(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${API_KEY}`
    );

    const video = response.data.items[0].snippet;
    return {
      title: video.title,
      description: video.description,
      thumbnailUrl: video.thumbnails.maxres?.url || video.thumbnails.high.url || video.thumbnails.default.url
    };
  } catch (error) {
    console.error('YouTube API Error:', error);
    throw error;
  }
}

// ---------- TWITTER METADATA (API) ----------
export async function getTwitterMetadata(tweetUrl: string): Promise<TwitterMetadata> {
  try {
    const tweetId = extractTweetId(tweetUrl);
    const bearerToken = process.env.TWITTER_BEARER_TOKEN?.trim();

    if (!bearerToken) {
      throw new Error('Twitter Bearer Token is not configured');
    }

    const response = await axios.get(
      `https://api.twitter.com/2/tweets/${tweetId}`,
      {
        headers: { 
          'Authorization': `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
        params: {
          'expansions': 'attachments.media_keys',
          'media.fields': 'url,preview_image_url,type'
        }
      }
    );

    const mediaUrls = response.data.includes?.media?.map((media: any) => {
      return media.type === 'video' ? media.preview_image_url : media.url;
    }) || [];

    return {
      text: response.data.data.text,
      author: response.data.data.author_id,
      mediaUrls
    };
  } catch (error) {
    console.error('Twitter API Error:', error);
    throw error;
  }
}

// ---------- HELPERS ----------
function extractYoutubeVideoId(url: string): string {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : '';
}

function extractTweetId(url: string): string {
  const matches = url.match(/twitter\.com\/\w+\/status\/(\d+)/);
  return matches ? matches[1] : '';
}
