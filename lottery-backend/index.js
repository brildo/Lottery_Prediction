const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Allow requests from anywhere (or restrict to your specific needs)
app.use(cors());
// Parse incoming JSON payloads
app.use(express.json({ limit: '10mb' }));

// IMPORTANT: Do not hardcode keys here. We will set them in Vercel's dashboard.
const QWEN_API_KEY = process.env.QWEN_API_KEY;

app.post('/api/predict', async (req, res) => {
    try {
        // Pass the entire payload from WeChat to Alibaba, but force streaming off
        const payload = req.body;
        payload.stream = false; 

        const response = await axios({
            url: '[https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions](https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions)',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${QWEN_API_KEY}`
            },
            data: payload
        });

        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "Server Error" });
    }
});

// Vercel requires the app to be exported
module.exports = app;