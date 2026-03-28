const env = require('./env.js');

App({
    onLaunch() {
        console.log('App Launch');
        // Initialize WeChat CloudBase — required for wx.cloud API calls
        // Set your environment ID in env.js (CLOUD_ENV_ID)
        if (wx.cloud) {
            wx.cloud.init({
                env: env.CLOUD_ENV_ID,
                traceUser: false // set to true to track users in CloudBase console
            });
            console.log('wx.cloud initialized with env:', env.CLOUD_ENV_ID);
        } else {
            console.warn('wx.cloud not available — CloudBase features will be disabled.');
        }
    },
    globalData: {
        userInfo: null
    }
})
