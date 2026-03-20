const env = require('../../env.js');
const amapFile = require('../../libs/amap-wx.js');
const recorderManager = wx.getRecorderManager();
const fm = wx.getFileSystemManager();
const innerAudioContext = wx.createInnerAudioContext();
// Note: welcomeAudio is created inside generateWelcomeVoice() to avoid
// calling wx APIs at module init time (causes real-phone loading issues)


Page({
    data: {
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

    onLoad() {
        this.initRecorder();
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

    generateWelcomeVoice() {
        const now = new Date();
        const y = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate();
        const wd = ['\u65e5', '\u4e00', '\u4e8c', '\u4e09', '\u56db', '\u4e94', '\u516d'][now.getDay()];
        const h = now.getHours();
        const timeWord = h < 6 ? '\u6df1\u591c' : h < 12 ? '\u65e9\u4e0a' : h < 18 ? '\u4e0b\u5348' : '\u665a\u4e0a';
        const userPrompt = `\u73b0\u5728\u662f${y}\u5e74${mo}\u6708${d}\u65e5\uff0c\u661f\u671f${wd}\uff0c${timeWord}\u3002\u8bf7\u751f\u6210\u4e00\u53e5\u4e0d\u8d85\u8fc715\u5b57\u7684\u5f69\u7968\u5409\u7965\u8fce\u5bbe\u8bed\uff0c\u53ea\u8f93\u51fa\u8fce\u5bbe\u8bed\u672c\u8eab\u3002`;

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

        // PCM from qwen3-omni: 16000 Hz mono 16-bit
        // Evidence: 24000 Hz header caused 1.5x chipmunk → actual = 24000/1.5 = 16000 Hz
        const buildWAV = (pcmBuf) => {
            const SR = 16000, CH = 1, BD = 16, dLen = pcmBuf.byteLength;
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

        let audioBuffers = [], played = false;

        // Dual-trigger: play on whichever fires last — [DONE] (PC) or success (phone)
        const tryPlay = () => {
            if (played || audioBuffers.length === 0) return;
            played = true;
            try {
                const totalLen = audioBuffers.reduce((a, b) => a + b.byteLength, 0);
                const pcm = new Uint8Array(totalLen);
                let off = 0;
                for (const buf of audioBuffers) { pcm.set(new Uint8Array(buf), off); off += buf.byteLength; }
                const destPath = `${wx.env.USER_DATA_PATH}/welcome_voice.wav`;
                fm.writeFileSync(destPath, wx.arrayBufferToBase64(buildWAV(pcm.buffer)), 'base64');
                const wAudio = wx.createInnerAudioContext();
                wAudio.obeyMuteSwitch = false;
                wAudio.onError((e) => console.warn('[Welcome] play error:', e));
                wAudio.src = destPath;
                wAudio.play();
                console.log('[Welcome] Playing PCM WAV (16kHz mono), bytes:', totalLen);
            } catch (e) { console.error('[Welcome] error:', e); }
        };

        const rtask = wx.request({
            url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            method: 'POST',
            enableChunked: true,
            header: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.QWEN_API_KEY}` },
            data: {
                model: 'qwen3-omni-flash-2025-12-01',
                messages: [{ role: 'user', content: userPrompt }],
                modalities: ['text', 'audio'],
                audio: { voice: 'Cherry', format: 'pcm' },
                stream: true,
                stream_options: { include_usage: true }
            },
            success: (res) => {
                if (res.statusCode !== 200) { console.warn('[Welcome] HTTP error:', res.statusCode); return; }
                tryPlay(); // fires after all data on phone
            },
            fail: (err) => { console.warn('[Welcome] fail:', err); }
        });
        rtask.onChunkReceived((resp) => {
            try {
                const txt = decodeUTF8(resp.data);
                for (let line of txt.split('\n')) {
                    line = line.trim();
                    if (!line) continue;
                    if (line === 'data: [DONE]') { tryPlay(); return; } // fires after all data on PC
                    if (line.startsWith('data: ')) {
                        try {
                            const p = JSON.parse(line.slice(6));
                            if (p.choices && p.choices[0].delta && p.choices[0].delta.audio && p.choices[0].delta.audio.data)
                                audioBuffers.push(wx.base64ToArrayBuffer(p.choices[0].delta.audio.data));
                        } catch (_) { }
                    }
                }
            } catch (_) { }
        });
    },




    onUnload() {
        innerAudioContext.destroy();
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
            });
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
                    iconPath: '/assets/marker.png',
                    width: 30,
                    height: 30
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
        // Scroll to top so user sees the crystal ball animation
        wx.pageScrollTo({ scrollTop: 0, duration: 300 });

        if (!this.data.audioPath && !this.data.manualText.trim()) {
            this.setData({ error: "请录制语音或输入文字描述您的经历。" });
            return;
        }
        if (this.data.isMapLoading) {
            this.setData({ error: "请等待附近彩站加载完毕。" });
            return;
        }

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
                locationStructure = `<h3>购彩方位指引</h3><p>...</p>`;
            }

            const promptText = `你是一个彩票占卜大师。请根据用户提供的语音或文字描述，进行极简运势分析，并生成 ${numSets} 组【${lotteryType}】号码。
                规则：双色球：红(01-33)*6 | 蓝(01-16)*1；大乐透：前(01-35)*5 | 后(01-12)*2；福彩3D/排列三：数字(0-9)*3
                严格要求：
                1. 极度精简！运势解析不超过3句话。选号玄机一句话总结即可。
                2. 仅使用基础的 HTML 标签 (如 <h3>, <p>, <strong>, <br>) 进行排版，严禁使用 markdown。
                3. 【重要】对每组彩票号码中的每个具体数字，必须用 <span class="lucky-num">数字</span> 包裹。对“运势”、“财运”、“吉”、“旺”、“大吉”等关键吉祥展词，用 <span class="kw">词语</span> 包裹。
                格式：
                <h3>运势解析</h3><p>...</p>
                <h3>专属幸运号码</h3><p>...</p>
                <h3>选号玄机</h3><p>...</p>
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

            // Hold off showing text for 2.5s so the crystal ball has time to animate
            let activeMarkdown = "";
            const animationTimer = setTimeout(() => {
                this.setData({ isAnimationFinished: true });
                if (activeMarkdown) {
                    this.setData({ 'result.markdown': activeMarkdown.replace(/```html/g, '').replace(/```/g, '') });
                }
            }, 2500);

            // Decode UTF-8 ArrayBuffer manually (TextDecoder is unreliable in WeChat)
            const decodeUTF8 = (buffer) => {
                let bytes = new Uint8Array(buffer);
                let out = "", i = 0, len = bytes.length;
                while (i < len) {
                    let c = bytes[i++];
                    switch (c >> 4) {
                        case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
                            out += String.fromCharCode(c); break;
                        case 12: case 13:
                            out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F)); break;
                        case 14:
                            out += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | ((bytes[i++] & 0x3F) << 0)); break;
                    }
                }
                return out;
            };

            const requestTask = wx.request({
                url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                method: 'POST',
                enableChunked: true,
                header: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.QWEN_API_KEY}`
                },
                data: {
                    model: 'qwen3-omni-flash-2025-12-01',
                    messages: [{ role: "user", content: userContent }],
                    modalities: ["text"],
                    stream: true,
                    stream_options: { include_usage: true }
                },
                success: (res) => {
                    this.setData({ isPredicting: false });
                    if (res.statusCode !== 200) {
                        clearTimeout(animationTimer);
                        console.error("Qwen API HTTP Error:", res.statusCode, res.data);
                        let errMsg = `API错误 ${res.statusCode}: 请求失败`;
                        if (res.data && res.data.error && res.data.error.message) {
                            errMsg = `API错误: ${res.data.error.message}`;
                        } else if (res.data && res.data.message) {
                            errMsg = `API错误: ${res.data.message}`;
                        }
                        this.setData({ error: errMsg, result: null });
                    }
                },
                fail: (err) => {
                    clearTimeout(animationTimer);
                    console.error("Qwen request fail:", err);
                    this.setData({ error: "请求失败，请检查网络或API Key。", isPredicting: false });
                }
            });

            requestTask.onChunkReceived((response) => {
                try {
                    const chunkStr = decodeUTF8(response.data);
                    const lines = chunkStr.split('\n');
                    for (let line of lines) {
                        line = line.trim();
                        if (!line || line === 'data: [DONE]') continue;
                        if (line.startsWith('data: ')) {
                            try {
                                const parsed = JSON.parse(line.slice(6));
                                if (parsed.choices && parsed.choices.length > 0) {
                                    const delta = parsed.choices[0].delta;
                                    if (delta && delta.content) {
                                        activeMarkdown += delta.content;
                                        if (this.data.isAnimationFinished) {
                                            this.setData({
                                                'result.markdown': activeMarkdown.replace(/```html/g, '').replace(/```/g, '')
                                            });
                                        }
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
        wx.openLocation({
            latitude: shop.latitude,
            longitude: shop.longitude,
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
