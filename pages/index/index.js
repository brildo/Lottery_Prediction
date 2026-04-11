const env = require('../../env.js');
const amapFile = require('../../libs/amap-wx.js');
const recorderManager = wx.getRecorderManager();
const fm = wx.getFileSystemManager();
const innerAudioContext = wx.createInnerAudioContext();
const MAX_DAILY_PREDICTIONS = 1; // Users can only predict 1 times per day
// Note: welcomeAudio is created inside generateWelcomeVoice() to avoid
// calling wx APIs at module init time (causes real-phone loading issues)

const decodeUTF8 = (buffer) => {
    let bytes = new Uint8Array(buffer), out = '', i = 0, len = bytes.length;
    while (i < len) {
        let c = bytes[i++];
        switch (c >> 4) {
            case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7: out += String.fromCharCode(c); break;
            case 12: case 13: out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F)); break;
            case 14: out += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | ((bytes[i++] & 0x3F) << 0)); break;
        }
    }
    return out;
};

const buildWAV = (pcmBuf) => {
    const SR = 24000, CH = 1, BD = 16, dLen = pcmBuf.byteLength;
    const hdr = new ArrayBuffer(44);
    const v = new DataView(hdr);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); v.setUint32(4, 36 + dLen, true);
    s(8, 'WAVE'); s(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, CH, true); v.setUint32(24, SR, true);
    v.setUint32(28, SR * CH * BD / 8, true); v.setUint16(32, CH * BD / 8, true);
    v.setUint16(34, BD, true); s(36, 'data'); v.setUint32(40, dLen, true);
    const out = new Uint8Array(44 + dLen);
    out.set(new Uint8Array(hdr), 0); out.set(new Uint8Array(pcmBuf), 44);
    return out.buffer;
};

Page({
    data: {
        welcomeText: "", // NEW: Store the welcome text
        isRecording: false,
        audioPath: null,
        isPlaying: false,
        manualText: "",
        lotteryType: "双色球",
        numSets: 1,
        recommendShop: false,
        searchRadius: 3000,
        isMapLoading: false,
        nearbyShops: [],
        mapMarkers: [],
        mapCenter: { lat: 39.9042, lng: 116.4074 }, // Default Beijing
        isPredicting: false,
        isAnimationFinished: false,
        error: null,
        result: null
    },

    onTextBlur(e) {
      // Triggered when the user finishes typing and hides the keyboard
      this.scrollToActionBtn();
  },

  scrollToActionBtn() {
      // Only scroll if they actually provided input
      if (this.data.audioPath || this.data.manualText.trim()) {
          wx.pageScrollTo({
              selector: '#actionBtn',
              duration: 300,
              // Negative offset pushes the button down toward the middle of the viewport
              offsetTop: -250 
          });
      }
  },

    onLoad() {
        this.initRecorder();
        // Fetch the user's real openid from wx.cloud (persists across reinstalls)
        this.initUserIdentity();
        // Delay welcome voice so the page finishes rendering first
        setTimeout(() => this.generateWelcomeVoice(), 1000);

        innerAudioContext.onPlay(() => { this.setData({ isPlaying: true }); });
        innerAudioContext.onPause(() => { this.setData({ isPlaying: false }); });
        innerAudioContext.onStop(() => { this.setData({ isPlaying: false }); });
        innerAudioContext.onEnded(() => { this.setData({ isPlaying: false }); });
        innerAudioContext.onError((res) => {
            console.error('Audio error', res);
            this.setData({ isPlaying: false });
        });
    },

    // Feature 3: Get the user's real openid from WeChat CloudBase.
    // The cloud function auto-receives openid — no login flow needed.
    // This persists across app updates and reinstalls.
    // Feature 3: Get the user's identity
    // Replaced cloud openid with a persistent local generated ID
    initUserIdentity() {
      // Check if cached ID exists from a previous session
      const cachedId = wx.getStorageSync('userOpenId');
      if (cachedId) {
          this.userOpenId = cachedId;
          console.log('[User] Loaded cached ID from storage:', this.userOpenId);
          return;
      }
      
      // Generate a random local ID instead of fetching cloud openid
      this.userOpenId = 'user_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
      wx.setStorageSync('userOpenId', this.userOpenId);
      console.log('[User] Generated and cached new local ID:', this.userOpenId);
  },

    generateWelcomeVoice() {
        const fetchWeatherAndGenerate = (weatherStr) => {
            const now = new Date();
            const y = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate();
            const wd = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
            const h = now.getHours();

            let timeWord = h < 6 ? '深夜' : h < 12 ? '早上' : h < 18 ? '下午' : '晚上';

            const userPrompt = `系统指令：你现在是一位温柔、知性、亲切的女性占卜师。
当前环境：${y}年${mo}月${d}日，星期${wd}，${timeWord}，当前天气是“${weatherStr}”。
任务：请充分结合当前的“${timeWord}”时间和“${weatherStr}”天气，用极其温柔和治愈的女性语气，生成一句彩票吉祥迎宾语（不超过20字）。例如：如果现在是下雨的清晨，可以说“雨水为你洗净前路，早安”。只输出迎宾语本身，不要加任何解释。`;

            let base64AudioData = '';
            let streamTextBuffer = '';
            let fullWelcomeText = '';
            let played = false;

            if (this.welcomeAudio) {
                this.welcomeAudio.stop();
                this.welcomeAudio.destroy();
            }
            this.welcomeAudio = wx.createInnerAudioContext();
            this.welcomeAudio.obeyMuteSwitch = false;
            this.welcomeAudio.onError((e) => console.warn('[Welcome] play error:', e));

            const tryPlay = () => {
                if (played || !base64AudioData) return;
                played = true;
                try {
                    const pcmBuffer = wx.base64ToArrayBuffer(base64AudioData);
                    const destPath = `${wx.env.USER_DATA_PATH}/welcome_voice_${Date.now()}.wav`;
                    fm.writeFileSync(destPath, wx.arrayBufferToBase64(buildWAV(pcmBuffer)), 'base64');
                    this.welcomeAudio.src = destPath;
                    this.welcomeAudio.play();
                } catch (e) { console.error('[Welcome] play process error:', e); }
            };

            const rtask = wx.request({
                url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                method: 'POST',
                enableChunked: true,
                header: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.QWEN_API_KEY}` },
                data: {
                    model: 'qwen3-omni-flash-2025-12-01',
                    messages: [
                        { role: 'system', content: '你是一位温柔知性的女性占卜师，请始终使用温柔的女声语气回答。' },
                        { role: 'user', content: userPrompt }
                    ],
                    modalities: ['text', 'audio'],
                    audio: { voice: 'Serena', format: 'pcm' },
                    enable_thinking: false,
                    stream: true,
                    stream_options: { include_usage: true }
                },
                success: (res) => {
                    if (res.statusCode === 200) { tryPlay(); }
                },
                fail: (err) => { console.warn('[Welcome] API fail:', err); }
            });

            rtask.onChunkReceived((resp) => {
                try {
                    streamTextBuffer += decodeUTF8(resp.data);
                    let lines = streamTextBuffer.split('\n');
                    streamTextBuffer = lines.pop();

                    for (let line of lines) {
                        line = line.trim();
                        if (!line) continue;
                        if (line === 'data: [DONE]') {
                            tryPlay();
                            return;
                        }
                        if (line.startsWith('data: ')) {
                            try {
                                const p = JSON.parse(line.slice(6));
                                if (p.choices && p.choices.length > 0 && p.choices[0].delta) {
                                    if (p.choices[0].delta.audio && p.choices[0].delta.audio.data) {
                                        base64AudioData += p.choices[0].delta.audio.data;
                                    }
                                    if (p.choices[0].delta.content) {
                                        fullWelcomeText += p.choices[0].delta.content;
                                        this.setData({ welcomeText: fullWelcomeText });
                                    }
                                }
                            } catch (parseErr) { }
                        }
                    }
                } catch (decodeErr) { }
            });
        };

        const elements = ['微风', '细雨', '阳光', '明媚', '朝霞', '晚霞', '云气', '星光'];
        fetchWeatherAndGenerate(elements[Math.floor(Math.random() * elements.length)]);
    },




    onUnload() {
        innerAudioContext.destroy();
        if (this.welcomeAudio) {
            this.welcomeAudio.destroy();
        }
        if (this.predictAudio) {
            this.predictAudio.destroy();
        }
    },

    initRecorder() {
        recorderManager.onStart(() => {
            this.setData({ isRecording: true, error: null });
        });

        recorderManager.onStop((res) => {
          const { tempFilePath } = res;
          this.setData({
              isRecording: false,
              audioPath: tempFilePath
          }, () => {
              // Scroll to the button after the state updates
              this.scrollToActionBtn();
          });
          this.transcribeAudio(tempFilePath);
      });

        recorderManager.onError((err) => {
            console.error('Recorder error:', err);
            this.setData({
                isRecording: false,
                audioPath: null,
                error: "录音无权限或被系统打断，请检查系统设置。"
            });
        });
    },

    transcribeAudio(tempFilePath) {
        try {
            const base64Audio = fm.readFileSync(tempFilePath, 'base64');
            wx.showLoading({ title: '语音识别中...', mask: false });
            wx.request({
                url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                method: 'POST',
                header: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.QWEN_API_KEY}`
                },
                data: {
                    model: 'qwen3-omni-flash-2025-12-01',
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "input_audio", input_audio: { data: `data:;base64,${base64Audio}`, format: "mp3" } },
                                { type: "text", text: "请精准转录这段音频，直接输出转录结果，不包含任何解释、寒暄或符号。" }
                            ]
                        }
                    ],
                    modalities: ["text"],
                    stream: false
                },
                success: (res) => {
                    wx.hideLoading();
                    if (res.statusCode === 200 && res.data && res.data.choices) {
                        const content = res.data.choices[0].message.content;
                        if (content) {
                            this.setData({ manualText: content.trim() });
                        }
                    } else {
                        console.error("[STT] Error Response", res.data);
                    }
                },
                fail: (err) => {
                    wx.hideLoading();
                    console.error("[STT] fail", err);
                }
            });
        } catch (e) { console.error("[STT] read file error", e); }
    },

    toggleRecord() {
        if (this.data.isRecording) {
            recorderManager.stop();
        } else {
            wx.getSetting({
                success: (res) => {
                    const authSetting = res.authSetting;
                    if (authSetting['scope.record']) {
                        this.startRecordingProcess();
                    } else if (authSetting['scope.record'] === false) {
                        wx.showModal({
                            title: '需要麦克风权限',
                            content: '录音功能需要您的授权。如果您曾拒绝授权，请点击"去设置"开启。',
                            confirmText: '去设置',
                            success: (modalRes) => {
                                if (modalRes.confirm) {
                                    wx.openSetting();
                                }
                            }
                        });
                    } else {
                        wx.authorize({
                            scope: 'scope.record',
                            success: () => {
                                this.startRecordingProcess();
                            },
                            fail: (err) => {
                                console.warn('Authorize failed:', err);
                                wx.showToast({ title: '录音授权失败', icon: 'none' });
                            }
                        });
                    }
                }
            });
        }
    },

    startRecordingProcess() {
        try {
            recorderManager.start({
                format: 'mp3',
                duration: 60000,
                sampleRate: 16000,
                numberOfChannels: 1
            });
        } catch (e) {
            console.error("Failed to start recorder:", e);
        }
    },

    playAudio() {
        if (this.data.audioPath) {
            if (this.data.isPlaying) {
                innerAudioContext.pause();
            } else {
                innerAudioContext.src = this.data.audioPath;
                innerAudioContext.play();
            }
        }
    },

    clearAudio() {
        this.setData({ audioPath: null, isPlaying: false });
        innerAudioContext.stop();
    },

    onTextInput(e) {
        this.setData({ manualText: e.detail.value });
    },

    selectLotteryType(e) {
        this.setData({ lotteryType: e.currentTarget.dataset.type });
        if (this.data.recommendShop && this.data.nearbyShops.length > 0) {
            this.triggerShopFetch();
        }
    },

    selectNumSets(e) {
        this.setData({ numSets: e.currentTarget.dataset.num });
    },

    toggleRecommendShop(e) {
        const isChecked = e.detail.value;
        this.setData({ recommendShop: isChecked });

        if (isChecked) {
            this.triggerShopFetch();
        } else {
            this.setData({ nearbyShops: [], mapMarkers: [] });
        }
    },

    onRadiusChange(e) {
        this.setData({ searchRadius: e.detail.value });
        if (this.data.recommendShop) {
            this.triggerShopFetch();
        }
    },

    async triggerShopFetch() {
        let shopType = "彩票";
        if (this.data.lotteryType === "双色球" || this.data.lotteryType === "福彩3D") shopType = "福利彩票";
        if (this.data.lotteryType === "大乐透" || this.data.lotteryType === "排列三") shopType = "体育彩票";

        try {
            this.setData({ isMapLoading: true });
            wx.showLoading({ title: '搜索附近彩站...', mask: true });
            const locationRes = await new Promise((resolve, reject) => {
                wx.getLocation({
                    type: 'gcj02',
                    success: resolve,
                    fail: reject
                });
            });

            const lat = locationRes.latitude;
            const lng = locationRes.longitude;

            this.setData({ mapCenter: { lat, lng } });

            let shops = await this.fetchNearbyShops(lat, lng, shopType);
            if (shops.length === 0) {
                shops = await this.fetchNearbyShops(lat, lng, "彩票");
            }

            const markers = shops.slice(0, 10).map((shop, i) => {
                const [slng, slat] = shop.location.split(',');
                return {
                    id: i,
                    latitude: parseFloat(slat),
                    longitude: parseFloat(slng),
                    title: shop.name,
                    iconPath: '/assets/marker.png'
                };
            });

            const formattedShops = shops.slice(0, 5).map((shop) => {
                let slng, slat;
                if (typeof shop.location === 'string') {
                    [slng, slat] = shop.location.split(',');
                } else {
                    slng = shop.longitude || shop.location.lng;
                    slat = shop.latitude || shop.location.lat;
                }

                return {
                    title: shop.name,
                    address: shop.address,
                    _distance: shop.distance,
                    location: {
                        lat: parseFloat(slat),
                        lng: parseFloat(slng)
                    }
                };
            });

            this.setData({
                nearbyShops: formattedShops,
                mapMarkers: markers,
                isMapLoading: false
            });
            wx.hideLoading();

        } catch (e) {
            console.warn("Location/Shop fetch failed:", e);
            wx.hideLoading();
            wx.showToast({ title: '无法获取位置', icon: 'none' });
            this.setData({ recommendShop: false, isMapLoading: false });
        }
    },

    fetchNearbyShops(lat, lng, keyword) {
        return new Promise((resolve) => {
            const myAmapFun = new amapFile.AMapWX({ key: env.AMAP_KEY });
            myAmapFun.getPoiAround({
                querykeywords: keyword,
                location: `${lng},${lat}`,
                radius: this.data.searchRadius,
                success: (data) => {
                    if (data && data.poisData && data.poisData.length > 0) {
                        resolve(data.poisData);
                    } else if (data && data.markers && data.markers.length > 0) {
                        resolve(data.markers);
                    } else {
                        console.warn("Amap SDK empty or no poisData:", data);
                        resolve([]);
                    }
                },
                fail: (info) => {
                    console.error("Amap SDK fail:", info);
                    resolve([]);
                }
            });
        });
    },

    async handlePredict() {
      // 1. Strict Validation: Make button functionally invalid if no input
      if (!this.data.audioPath && !this.data.manualText.trim()) {
          // The button is visually disabled via CSS. We return silently to ignore clicks.
          // Alternatively, you can use wx.showToast({ title: '请输入线索', icon: 'none' });
          return; 
      }

      if (this.data.isMapLoading) {
          wx.showToast({ title: '请等待附近彩站加载', icon: 'none' });
          return;
      }

      // Scroll to top so user sees the crystal ball animation
      wx.pageScrollTo({ scrollTop: 0, duration: 300 });

      // --- Feature 3: Per-User Daily Rate Limit ---
      const uid = this.userOpenId || 'anonymous';
      const dailyKey = `dailyUsage_${uid}`;
      const todayStr = new Date().toDateString();
      let usageData = wx.getStorageSync(dailyKey) || { date: todayStr, count: 0 };

      if (usageData.date !== todayStr) {
          usageData = { date: todayStr, count: 0 };
      }

      // 2. Change limit warning to a Popup Modal
      if (usageData.count >= MAX_DAILY_PREDICTIONS) {
          wx.showModal({
              title: '灵气耗尽',
              content: `今日占卜次数已达上限，请明日再来（每日限额 ${MAX_DAILY_PREDICTIONS} 次）。`,
              showCancel: false,
              confirmText: '我知道了',
              confirmColor: '#a855f7'
          });
          return;
      }
      // ---------------------------------------------------------------------------

      this.setData({
          isPredicting: true,
          error: null,
          result: null
      });

      try {
          const { lotteryType, numSets, manualText, audioPath, recommendShop, nearbyShops } = this.data;
            let shopsInfo = "";
            let locationStructure = "";

            if (recommendShop) {
                if (nearbyShops.length > 0) {
                    shopsInfo = `\n已搜集到该用户周边的实际彩票店列表：\n` +
                        nearbyShops.map((s, i) => `[编号${i + 1}] ${s.title} (距离: ${s._distance}米)`).join('\n') +
                        `\n【强制指令】：在"购彩方位指引"中，你必须仔细分析上述店铺的名称寓意或方位，有理有据地为您认为最吉利的一家店铺做推荐。\n绝对禁止默认选择第一家！必须结合玄学/名称/风水挑选最独特、最合适的一家，并在推荐时带上其确切店名。`;
                } else {
                    shopsInfo = `\n未获取到附近店铺，在"购彩方位指引"中给出一句一般的购彩方位建议即可（如宜往东）。`;
                }
                locationStructure = `\n【购彩方位指引】...\n`;
            }

            const promptText = `你是一个彩票占卜大师。请根据用户提供的语音或文字描述，进行极简运势分析，并生成 ${numSets} 组【${lotteryType}】号码。
                规则：双色球：红(01-33)*6 | 蓝(01-16)*1；大乐透：前(01-35)*5 | 后(01-12)*2；福彩3D/排列三：数字(0-9)*3
                严格要求：
                1. 极度精简！运势解析不超过3句话。选号玄机一句话总结即可。如果用户输入的字符（包含字母标点）少于3个字，或是完全无意义的重复字母乱码，您才可以拒绝占卜并仅输出：“今日无特别经历，不适合占卜。”除此之外，只要用户描述了任何一丁点的日常（比如只写了“吃个饭”、“无聊”等），都必须为其占卜，绝对不要拒绝！
                2. 绝对禁止输出任何 HTML 代码、标签（如 <h3>, <p>, <span> 等）以及 Markdown 符号（如 #, *）。必须纯文本输出，确保生成的语音朗读自然畅顺！
                格式：
                【运势解析】...
                【专属幸运号码】...
                【选号玄机】...
                ${locationStructure}
                ${shopsInfo}
            `;

            // UNIFIED MODEL: qwen3-omni-flash-2025-12-01 via OpenAI-compatible SSE streaming
            // Audio: uses `input_audio` with the REQUIRED `data:;base64,` URI prefix
            // per official docs: https://help.aliyun.com/zh/model-studio/qwen-omni

            let textContent = "";
            if (manualText && manualText.trim().length > 0) {
                textContent += `用户额外补充文本：${manualText}\n`;
            }
            textContent += promptText;

            // Build the user message — array with audio+text parts, or plain string for text-only
            let userContent;
            if (audioPath) {
                let base64Audio;
                try {
                    base64Audio = fm.readFileSync(audioPath, 'base64');
                    console.log("[Audio] base64 length:", base64Audio.length);
                } catch (readErr) {
                    console.error("[Audio] File read error:", readErr);
                    this.setData({ error: "音频文件读取失败，请重新录音。", isPredicting: false, result: null });
                    return;
                }

                // CRITICAL: Alibaba official docs require the `data:;base64,` data URI prefix
                userContent = [
                    {
                        type: "input_audio",
                        input_audio: {
                            data: `data:;base64,${base64Audio}`,
                            format: "mp3"
                        }
                    },
                    { type: "text", text: "请仔细听这段语音描述，作为占卜依据：\n" + textContent }
                ];
            } else {
                userContent = textContent;
            }

            // Initialize result view — empty markdown lets the crystal ball animation show
            const mapLinks = recommendShop ? nearbyShops.map(shop => ({
                title: shop.title,
                latitude: shop.location.lat,
                longitude: shop.location.lng,
                address: shop.address
            })) : [];

            this.setData({
                result: { markdown: "", mapLinks: mapLinks },
                isAnimationFinished: false
            });

            // Delay showing text so the crystal ball holds until [DONE] finishes bridging the time gap
            let activeMarkdown = "";
            let base64AudioData = '';
            let streamTextBuffer = '';
            let played = false;

            if (this.predictAudio) {
                this.predictAudio.stop();
                this.predictAudio.destroy();
            }
            this.predictAudio = wx.createInnerAudioContext();
            this.predictAudio.obeyMuteSwitch = false;
            this.predictAudio.onError((e) => console.warn('[Predict] play error:', e));

            const tryPlay = () => {
                if (played) return;

                // Show result now that the whole audio block is downloaded
                this.setData({
                    isAnimationFinished: true,
                    'result.markdown': activeMarkdown.replace(/```/g, '').replace(/\n/g, '<br/>').replace(/【(.*?)】/g, '<h3 style="color:#eab308; margin-top:12px;">【$1】</h3>')
                });

                if (!base64AudioData) return;
                played = true;
                try {
                    const pcmBuffer = wx.base64ToArrayBuffer(base64AudioData);
                    const destPath = `${wx.env.USER_DATA_PATH}/predict_voice_${Date.now()}.wav`;
                    fm.writeFileSync(destPath, wx.arrayBufferToBase64(buildWAV(pcmBuffer)), 'base64');
                    this.predictAudio.src = destPath;
                    this.predictAudio.play();
                } catch (e) { console.error('[Predict] play process error:', e); }
            };

            const requestTask = wx.request({
              // Replace with your actual Vercel URL
              url: '[https://lottery-backend-khaki.vercel.app/api/predict](https://lottery-backend-khaki.vercel.app/api/predict)', 
              method: 'POST',
              data: {
                  messages: [{ role: "user", content: userContent }],
                  stream: false
              },
              success: (res) => {
                  if (res.data.success) {
                      const content = res.data.data.choices[0].message.content;
                      this.setData({
                          isAnimationFinished: true,
                          'result.markdown': content
                      });
                  } else {
                      this.setData({ error: "占卜失败" });
                  }
              },
              fail: (err) => {
                  this.setData({ error: "请求失败，请检查网络" });
              }
          });

            requestTask.onChunkReceived((response) => {
                try {
                    streamTextBuffer += decodeUTF8(response.data);
                    let lines = streamTextBuffer.split('\n');
                    streamTextBuffer = lines.pop(); // keep remainder

                    for (let line of lines) {
                        line = line.trim();
                        if (!line || line === 'data: [DONE]') continue;

                        if (line === 'data: [DONE]') {
                            tryPlay();
                            return;
                        }

                        if (line.startsWith('data: ')) {
                            try {
                                const parsed = JSON.parse(line.slice(6));
                                if (parsed.choices && parsed.choices.length > 0) {
                                    const delta = parsed.choices[0].delta;
                                    if (delta && delta.audio && delta.audio.data) {
                                        base64AudioData += delta.audio.data;
                                    }
                                    if (delta && delta.content) {
                                        activeMarkdown += delta.content;
                                    }
                                }
                            } catch (parseErr) {
                                console.warn("Failed to parse SSE chunk JSON:", parseErr);
                            }
                        }
                    }
                } catch (decodeErr) {
                    console.error("TextDecode Error:", decodeErr);
                }
            });

        } catch (err) {
            console.error("Prediction error:", err);
            this.setData({
                error: "占卜过程中发生了神秘的干扰，请稍后再试。",
                isPredicting: false
            });
        }
    },

    openMap(e) {
        const shop = e.currentTarget.dataset.shop;
        const lat = Number(shop.latitude || (shop.location && shop.location.lat));
        const lng = Number(shop.longitude || (shop.location && shop.location.lng));
        wx.openLocation({
            latitude: lat,
            longitude: lng,
            name: shop.title,
            address: shop.address,
            scale: 18
        });
    },

    resetApp() {
        this.setData({
            result: null,
            error: null
        });
        wx.pageScrollTo({ scrollTop: 0, duration: 300 });
    }
});
