const express = require('express');
const cors = require('cors');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

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
        ffmpeg().input('anullsrc=r=44100:cl=stereo').inputFormat('lavfi')
          .duration(slides.length * 5).audioCodec('libmp3lame')
          .save(audioPath).on('end', res).on('error', rej);
      });
    }

    const editedClips = [];
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const outputPath = path.join(jobDir, `edited_${i}.mp4`);
      const caption = slide.caption.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      const sub = slide.text.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      await new Promise((res, rej) => {
        ffmpeg(videoFiles[i] || videoFiles[0]).seekInput(0).duration(5)
          .videoFilters([
            'scale=1080:1920:force_original_aspect_ratio=increase',
            'crop=1080:1920',
            'drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill',
            `drawtext=text='${caption}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=350:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:shadowcolor=black:shadowx=3:shadowy=3`,
            `drawtext=text='${sub}':fontsize=38:fontcolor=white@0.85:x=60:y=h-200:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:shadowcolor=black:shadowx=2:shadowy=2`,
          ])
          .videoCodec('libx264').audioCodec('aac')
          .outputOptions(['-preset ultrafast', '-crf 28', '-pix_fmt yuv420p'])
          .save(outputPath).on('end', res).on('error', rej);
      });
      editedClips.push(outputPath);
    }

    const concatList = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatList, editedClips.map(f => `file '${f}'`).join('\n'));
    const mergedPath = path.join(jobDir, 'merged.mp4');
    await new Promise((res, rej) => {
      ffmpeg().input(concatList).inputOptions(['-f concat', '-safe 0'])
        .videoCodec('copy').audioCodec('aac')
        .save(mergedPath).on('end', res).on('error', rej);
    });

    const finalPath = path.join(jobDir, 'final.mp4');
    await new Promise((res, rej) => {
      ffmpeg().input(mergedPath).input(audioPath)
        .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a aac', '-shortest'])
        .save(finalPath).on('end', res).on('error', rej);
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.mp4"`);
    fs.createReadStream(finalPath).pipe(res);
    res.on('finish', () => setTimeout(() => fs.rmSync(jobDir, { recursive: true, force: true }), 5000));

  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e2) {}
  }
});

/* ── 쿠팡 파트너스: 상품 검색 ── */
app.post('/coupang-search', async (req, res) => {
  try {
    const { keyword, categoryId, limit = 10, accessKey, secretKey, trackingId } = req.body;
    if (!accessKey || !secretKey) return res.status(400).json({ error: 'API 키 없음' });

    const method = 'GET';
    const path2 = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
    let qs = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
    if (categoryId && categoryId !== '0') qs += `&categoryId=${categoryId}`;

    const datetime = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const message = `${datetime}\n${method}\n${path2}\n${qs}\n`;
    const sig = crypto.createHmac('sha256', secretKey).update(message).digest('hex');

    const apiRes = await axios.get(`https://api-gateway.coupang.com${path2}?${qs}`, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${sig}`,
      }
    });
    res.json(apiRes.data);
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ error: msg });
  }
});

/* ── 쿠팡 파트너스: 링크 자동 생성 ── */
app.post('/coupang-link', async (req, res) => {
  try {
    const { coupangUrl, accessKey, secretKey, trackingId = 'default' } = req.body;
    if (!accessKey || !secretKey) return res.status(400).json({ error: 'API 키 없음' });

    const method = 'GET';
    const path2 = '/v2/providers/affiliate_open_api/apis/openapi/products/links';
    const qs = `coupangUrls=${encodeURIComponent(coupangUrl)}&subId=${trackingId}`;

    const datetime = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const message = `${datetime}\n${method}\n${path2}\n${qs}\n`;
    const sig = crypto.createHmac('sha256', secretKey).update(message).digest('hex');

    const apiRes = await axios.get(`https://api-gateway.coupang.com${path2}?${qs}`, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${sig}`,
      }
    });
    const item = Array.isArray(apiRes.data.data) ? apiRes.data.data[0] : apiRes.data.data;
    res.json({ shortenUrl: item?.shortenUrl || item?.landingUrl || coupangUrl });
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ error: msg });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`BABI CAST 서버 포트 ${PORT} 실행 중`));


const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => res.send('BABI CAST 서버 포트 ' + PORT + ' 실행 중'));

/* ───────────────────────────────────────────
   기존: 영상 생성
─────────────────────────────────────────── */
app.post('/create-video', async (req, res) => {
  try {
    const { topic, category, claudeKey, pexelsKey, openaiKey, voice, scriptData } = req.body;

    // 1) 대본 슬라이드
    const slides = scriptData?.slides || [];

    // 2) Pexels 영상 클립 검색
    const pexelsRes = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(topic)}&per_page=${slides.length}&orientation=portrait`,
      { headers: { Authorization: pexelsKey } }
    );
    const pexelsData = await pexelsRes.json();
    const videoUrls = (pexelsData.videos || []).map(v => {
      const file = v.video_files.find(f => f.quality === 'hd' && f.width <= 1080) || v.video_files[0];
      return file?.link;
    }).filter(Boolean);

    // 응답 (클라이언트에서 처리)
    res.json({ slides, videoUrls, title: scriptData?.title || topic });
  } catch (e) {
    console.error('/create-video error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ───────────────────────────────────────────
   쿠팡 파트너스: 상품 검색
─────────────────────────────────────────── */
app.post('/coupang-search', async (req, res) => {
  try {
    const { keyword, categoryId, limit = 10, accessKey, secretKey, trackingId } = req.body;
    if (!accessKey || !secretKey) return res.status(400).json({ error: 'API 키 없음' });

    const method = 'GET';
    const path = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
    let qs = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
    if (categoryId && categoryId !== '0') qs += `&categoryId=${categoryId}`;

    const datetime = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const message = `${datetime}\n${method}\n${path}\n${qs}\n`;
    const sig = crypto.createHmac('sha256', secretKey).update(message).digest('hex');

    const apiRes = await fetch(
      `https://api-gateway.coupang.com${path}?${qs}`,
      {
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${sig}`,
        }
      }
    );
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: data.message || '쿠팡 API 오류' });
    res.json(data);
  } catch (e) {
    console.error('/coupang-search error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ───────────────────────────────────────────
   쿠팡 파트너스: 파트너스 링크 자동 생성
─────────────────────────────────────────── */
app.post('/coupang-link', async (req, res) => {
  try {
    const { coupangUrl, accessKey, secretKey, trackingId = 'default' } = req.body;
    if (!accessKey || !secretKey) return res.status(400).json({ error: 'API 키 없음' });

    const method = 'GET';
    const path = '/v2/providers/affiliate_open_api/apis/openapi/products/links';
    const qs = `coupangUrls=${encodeURIComponent(coupangUrl)}&subId=${trackingId}`;

    const datetime = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const message = `${datetime}\n${method}\n${path}\n${qs}\n`;
    const sig = crypto.createHmac('sha256', secretKey).update(message).digest('hex');

    const apiRes = await fetch(
      `https://api-gateway.coupang.com${path}?${qs}`,
      {
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${sig}`,
        }
      }
    );
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: data.message || '링크 생성 오류' });
    const item = Array.isArray(data.data) ? data.data[0] : data.data;
    res.json({ shortenUrl: item?.shortenUrl || item?.landingUrl || coupangUrl });
  } catch (e) {
    console.error('/coupang-link error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`BABI CAST 서버 포트 ${PORT} 실행 중`));
