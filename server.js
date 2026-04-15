const express = require('express');
const cors = require('cors');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const cheerio = require('cheerio');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const TMP = '/tmp/babicast';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

app.get('/', (req, res) => res.json({ status: 'BABI CAST 서버 작동중' }));

/* ── 쿠팡 직접 검색 (스크래핑) ── */
app.post('/coupang-scrape', async (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword) return res.status(400).json({ error: '검색어 없음' });

    const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}&channel=user&sorter=scoreDesc&listSize=20`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Referer': 'https://www.coupang.com',
        'Cookie': 'PCID=; sid=; x-coupang-origin-region=KOREA;',
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const products = [];

    $('li.search-product').each((i, el) => {
      if (i >= 10) return false;
      const name = $(el).find('.name').text().trim() || $(el).find('.product-name').text().trim();
      const price = $(el).find('.price-value').text().trim() || $(el).find('.normal-price').text().trim();
      const img = $(el).find('img.product-image').attr('src') || $(el).find('img').first().attr('src') || '';
      const href = $(el).find('a.search-product-link').attr('href') || $(el).find('a').first().attr('href') || '';
      const productUrl = href.startsWith('http') ? href : 'https://www.coupang.com' + href;
      const isRocket = $(el).find('.badge-rocket').length > 0 || $(el).find('[class*="rocket"]').length > 0;
      const rating = $(el).find('.rating').text().trim();

      if (name && price) {
        products.push({ name, price: price + '원', img, productUrl, isRocket, rating });
      }
    });

    if (!products.length) {
      // 파싱 실패시 대체 셀렉터 시도
      $('[data-product-id]').each((i, el) => {
        if (i >= 10) return false;
        const name = $(el).find('[class*="name"]').first().text().trim();
        const price = $(el).find('[class*="price"]').first().text().trim();
        const img = $(el).find('img').first().attr('src') || '';
        const href = $(el).find('a').first().attr('href') || '';
        const productUrl = href.startsWith('http') ? href : 'https://www.coupang.com' + href;
        if (name) products.push({ name, price, img, productUrl, isRocket: false, rating: '' });
      });
    }

    res.json({ products });
  } catch (e) {
    console.error('/coupang-scrape error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── 쿠팡 파트너스: 상품 검색 (API) ── */
app.post('/coupang-search', async (req, res) => {
  try {
    const { keyword, categoryId, limit = 10, accessKey, secretKey } = req.body;
    if (!accessKey || !secretKey) return res.status(400).json({ error: 'API 키 없음' });
    const method = 'GET';
    const apiPath = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
    let qs = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
    if (categoryId && categoryId !== '0') qs += `&categoryId=${categoryId}`;
    const datetime = new Date().toISOString().replace(/[-:T]/g,'').slice(0,14);
    const sig = crypto.createHmac('sha256', secretKey).update(`${datetime}\n${method}\n${apiPath}\n${qs}\n`).digest('hex');
    const apiRes = await axios.get(`https://api-gateway.coupang.com${apiPath}?${qs}`, {
      headers: { 'Content-Type': 'application/json;charset=UTF-8',
        Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${sig}` }
    });
    res.json(apiRes.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

/* ── 쿠팡 파트너스: 링크 자동 생성 ── */
app.post('/coupang-link', async (req, res) => {
  try {
    const { coupangUrl, accessKey, secretKey, trackingId = 'default' } = req.body;
    if (!accessKey || !secretKey) return res.status(400).json({ error: 'API 키 없음' });
    const method = 'GET';
    const apiPath = '/v2/providers/affiliate_open_api/apis/openapi/products/links';
    const qs = `coupangUrls=${encodeURIComponent(coupangUrl)}&subId=${trackingId}`;
    const datetime = new Date().toISOString().replace(/[-:T]/g,'').slice(0,14);
    const sig = crypto.createHmac('sha256', secretKey).update(`${datetime}\n${method}\n${apiPath}\n${qs}\n`).digest('hex');
    const apiRes = await axios.get(`https://api-gateway.coupang.com${apiPath}?${qs}`, {
      headers: { 'Content-Type': 'application/json;charset=UTF-8',
        Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${sig}` }
    });
    const item = Array.isArray(apiRes.data.data) ? apiRes.data.data[0] : apiRes.data.data;
    res.json({ shortenUrl: item?.shortenUrl || item?.landingUrl || coupangUrl });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

/* ── 영상 생성 ── */
app.post('/create-video', async (req, res) => {
  const { topic, category, claudeKey, pexelsKey, openaiKey, voice } = req.body;
  const jobId = uuidv4();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    const scriptRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 2000,
      system: '한국 SNS 숏폼 대본 전문가. JSON만 응답.',
      messages: [{ role: 'user', content: `주제: ${topic}\n카테고리: ${category}\nJSON: {"title":"제목","keywords":["english keyword1","english keyword2"],"slides":[{"caption":"핵심한줄(10자이내)","text":"나레이션"}]}\n키워드는 반드시 Pexels 검색용 영어로 작성` }]
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
      const caption = slide.caption.replace(/'/g,"\\'").replace(/:/g,"\\:").replace(/\[/g,"\\[").replace(/\]/g,"\\]");
      const sub = slide.text.replace(/'/g,"\\'").replace(/:/g,"\\:").replace(/\[/g,"\\[").replace(/\]/g,"\\]");
      await new Promise((res, rej) => {
        ffmpeg(videoFiles[i] || videoFiles[0]).seekInput(0).duration(5)
          .videoFilters([
            'scale=1080:1920:force_original_aspect_ratio=increase','crop=1080:1920',
            'drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill',
            `drawtext=text='${caption}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=350:fontfile=/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf:shadowcolor=black:shadowx=3:shadowy=3`,
            `drawtext=text='${sub}':fontsize=38:fontcolor=white@0.85:x=60:y=h-200:fontfile=/usr/share/fonts/truetype/nanum/NanumGothic.ttf:shadowcolor=black:shadowx=2:shadowy=2`,
          ])
          .videoCodec('libx264').audioCodec('aac')
          .outputOptions(['-preset ultrafast','-crf 28','-pix_fmt yuv420p'])
          .save(outputPath).on('end', res).on('error', rej);
      });
      editedClips.push(outputPath);
    }
    const concatList = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatList, editedClips.map(f => `file '${f}'`).join('\n'));
    const mergedPath = path.join(jobDir, 'merged.mp4');
    await new Promise((res, rej) => {
      ffmpeg().input(concatList).inputOptions(['-f concat','-safe 0'])
        .videoCodec('copy').audioCodec('aac')
        .save(mergedPath).on('end', res).on('error', rej);
    });
    const finalPath = path.join(jobDir, 'final.mp4');
    await new Promise((res, rej) => {
      ffmpeg().input(mergedPath).input(audioPath)
        .outputOptions(['-map 0:v:0','-map 1:a:0','-c:v copy','-c:a aac','-shortest'])
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`BABI CAST 서버 포트 ${PORT} 실행 중`));
