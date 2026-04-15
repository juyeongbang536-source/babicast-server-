const express = require('express');
const cors = require('cors');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const TMP = '/tmp/babicast';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

app.get('/', (req, res) => res.json({ status: 'BABI CAST 서버 작동중' }));

app.post('/create-video', async (req, res) => {
  const { topic, category, claudeKey, pexelsKey, openaiKey, voice } = req.body;
  const jobId = uuidv4();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const scriptRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: '한국 SNS 숏폼 대본 전문가. JSON만 응답.',
      messages: [{ role: 'user', content: `주제: ${topic}\n카테고리: ${category}\nJSON: {"title":"제목","keywords":["키워드1","키워드2"],"slides":[{"caption":"핵심한줄","text":"나레이션"}]}` }]
    }, { headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' } });

    const scriptText = scriptRes.data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const scriptData = JSON.parse(scriptText.match(/\{[\s\S]*\}/)[0]);
    const { title, keywords, slides } = scriptData;

    const videoFiles = [];
    for (let i = 0; i < slides.length; i++) {
      const keyword = keywords[i % keywords.length] || topic;
      try {
        const pexelsRes = await axios.get('https://api.pexels.com/videos/search', {
          headers: { Authorization: pexelsKey },
          params: { query: keyword, per_page: 5, orientation: 'portrait' }
        });
        const videos = pexelsRes.data.videos;
        if (!videos || !videos.length) throw new Error('no video');
        const video = videos[Math.floor(Math.random() * videos.length)];
        const file = video.video_files.find(f => f.quality === 'sd' || f.quality === 'hd') || video.video_files[0];
        const videoPath = path.join(jobDir, `clip_${i}.mp4`);
        const writer = fs.createWriteStream(videoPath);
        const clipRes = await axios({ url: file.link, method: 'GET', responseType: 'stream' });
        clipRes.data.pipe(writer);
        await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
        videoFiles.push(videoPath);
      } catch (e) {
        if (videoFiles.length > 0) videoFiles.push(videoFiles[videoFiles.length - 1]);
      }
    }

    if (!videoFiles.length) throw new Error('영상 클립 다운로드 실패');

    const ttsText = slides.map(s => s.text).join('. ');
    const audioPath = path.join(jobDir, 'audio.mp3');

    if (openaiKey) {
      const ttsRes = await axios.post('https://api.openai.com/v1/audio/speech', {
        model: 'tts-1', input: ttsText, voice: voice || 'nova', speed: 1.05
      }, { headers: { Authorization: `Bearer ${openaiKey}` }, responseType: 'stream' });
      const writer = fs.createWriteStream(audioPath);
      ttsRes.data.pipe(writer);
      await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
    } else {
      await new Promise((res, rej) => {
        ffmpeg().input('anullsrc=r=44100:cl=stereo').inputFormat('lavfi'
